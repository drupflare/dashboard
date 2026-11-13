import { describe, expect, it } from 'vitest';
import { cutoverPortsOf } from '../../../engine/src/adapters/cutover';
import {
	createCutoverDestination,
	CUTOVER_MISSING_CONTRACTS,
	DESTINATION_REFUSALS,
	tablesTouched
} from '../../../engine/src/adapters/cutover-destination';
import { dohReader, pointsAt, type DnsLookup } from '../../../engine/src/adapters/cutover-dns';
import { createCutoverSource, SOURCE_REFUSALS } from '../../../engine/src/adapters/cutover-source';
import {
	cutoverKeys,
	digestOfParts,
	keyParts,
	manifestOfMarker,
	markerOf,
	parseMarker,
	parseSourceRef,
	readCopy,
	sha256Hex,
	writeManifest
} from '../../../engine/src/adapters/cutover-store';
import { createDumpStream, type StreamConnector } from '../../../engine/src/adapters/dump-stream';
import type { SshConnector } from '../../../engine/src/adapters/ssh-survey';
import { partKey } from '../../../engine/src/import-parts';
import type { BackupSite, ImportState, ImportStore, SqlConverter } from '../../../engine/src/ports';
import { PermanentError } from '../../../engine/src/step';
import { fakeBlobs } from './backup-fakes';
import {
	CREDENTIAL_ID,
	KEY_MARKER,
	PRIVATE_KEY,
	PUBLIC_IP,
	ROOT,
	SERVER_FINGERPRINT,
	SERVER_KEY
} from './import-fakes';

const ORG = `org_${'o'.repeat(26)}`;
const OP = `op_${'p'.repeat(26)}`;
const SITE = `site_${'s'.repeat(26)}`;
const REF = `${CREDENTIAL_ID}${ROOT}`;
const HOSTNAME = 'www.example.edu';
const NEW_ADDRESS = 'new-site.drupflare.app';

const failureOf = async (promise: Promise<unknown>): Promise<Error> =>
	(await promise.then(
		() => new Error('expected a refusal'),
		(caught: unknown) => caught
	)) as Error;

// #region the old server

const NODE_TABLE = 'DROP TABLE IF EXISTS `node`;\nCREATE TABLE `node` (`nid` int NOT NULL);\n';

interface Server {
	maintenance: string;
	readOnly: string;
	modules: string[];
	tables: string[];
	// the rows a visitor wrote that the next dump carries
	rows: string[];
	ignoreSet: boolean;
	emptyDump: boolean;
	dropStreams: number;
	commands: string[];
	streams: string[];
	sessions: number;
}

function fakeServer(patch: Partial<Server> = {}) {
	const server: Server = {
		maintenance: '',
		readOnly: 'false',
		modules: ['node', 'system'],
		tables: [
			'node',
			'node_field_data',
			'users',
			'sequences',
			'sessions',
			'cache_default',
			'watchdog'
		],
		rows: [],
		ignoreSet: false,
		emptyDump: false,
		dropStreams: 0,
		commands: [],
		streams: [],
		sessions: 0,
		...patch
	};
	const dumpFor = (command: string) => {
		if (server.emptyDump) return '';
		const only = /--tables-list=(\S+)/.exec(command)?.[1]?.replaceAll("'", '');
		const tables = only === undefined ? server.tables : only.split(',');
		return (
			tables
				.map(
					(table) =>
						`DROP TABLE IF EXISTS \`${table}\`;\nCREATE TABLE \`${table}\` (\`id\` int);\n`
				)
				.join('') +
			server.rows.map((row) => `INSERT INTO \`node\` VALUES ('${row}');\n`).join('')
		);
	};
	const answer = (command: string): { code: number; out: string } => {
		const bare = command.replace(/^cd '[^']*' && /, '');
		if (bare === 'drush state:get system.maintenance_mode') {
			return { code: 0, out: `${server.maintenance}\n` };
		}
		const set = /^drush state:set system\.maintenance_mode '?([^']*)'?$/.exec(bare);
		if (set !== null) {
			if (!server.ignoreSet) server.maintenance = set[1]!;
			return { code: 0, out: '' };
		}
		if (bare === 'drush state:delete system.maintenance_mode') {
			if (!server.ignoreSet) server.maintenance = '';
			return { code: 0, out: '' };
		}
		if (bare === 'drush sql:query "SHOW TABLES"') {
			return { code: 0, out: `${server.tables.join('\n')}\n` };
		}
		if (bare.startsWith('drush pm:list'))
			return { code: 0, out: `${server.modules.join('\n')}\n` };
		if (bare.startsWith('drush config:get readonlymode.settings enabled')) {
			return { code: 0, out: `${server.readOnly}\n` };
		}
		const config = /^drush config:set -y readonlymode\.settings enabled (\d)$/.exec(bare);
		if (config !== null) {
			server.readOnly = config[1] === '1' ? 'true' : 'false';
			return { code: 0, out: '' };
		}
		return { code: 1, out: '' };
	};
	const session = {
		async exec(command: string) {
			server.commands.push(command);
			const { code, out } = answer(command);
			return { code, stdoutText: out, stderrText: `server said ${KEY_MARKER}` };
		},
		async stream(command: string) {
			server.streams.push(command);
			const bytes = new TextEncoder().encode(dumpFor(command));
			if (server.dropStreams > 0) {
				server.dropStreams--;
				return {
					stdout: new ReadableStream<Uint8Array>({
						start: (controller) => controller.error(new Error('channel reset'))
					}),
					stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
					exit: Promise.resolve({ code: 255 })
				};
			}
			return {
				stdout: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					}
				}),
				stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
				exit: Promise.resolve({ code: 0 })
			};
		},
		async close() {}
	};
	const connector: SshConnector & StreamConnector = {
		resolve: async () => [PUBLIC_IP],
		fingerprint: async (key) => `SHA256:${new TextDecoder().decode(key)}`,
		async connect(options) {
			server.sessions++;
			if (!(await options.hostKey.verify('ssh-ed25519', SERVER_KEY))) {
				throw new Error('host key rejected');
			}
			return session;
		}
	};
	return { server, connector };
}

// splits on a newline so a dump spans windows; the last window is taken whole
const converter: SqlConverter = {
	async convertChunk(bytes, last) {
		const text = new TextDecoder().decode(bytes);
		const cut = last
			? bytes.length
			: new TextEncoder().encode(text.slice(0, text.lastIndexOf('\n') + 1)).length;
		return {
			cut,
			sql: new TextDecoder().decode(bytes.subarray(0, cut)),
			rows: 0,
			statements: 0
		};
	}
};

// #endregion

function sourceWorld(
	serverPatch: Partial<Server> = {},
	options: { lookup?: () => Promise<DnsLookup>; refuse?: Error; partBytes?: number } = {}
) {
	const { server, connector } = fakeServer(serverPatch);
	const store = fakeBlobs();
	const opened: { credentialId: string; orgId: string; root: string }[] = [];
	const imports: ImportStore = {
		async withTarget(credentialId, orgId, root, use) {
			opened.push({ credentialId, orgId, root });
			if (options.refuse) throw options.refuse;
			return use({
				host: 'source.example.test',
				port: 22,
				user: 'deploy',
				privateKey: PRIVATE_KEY,
				expectedFingerprint: SERVER_FINGERPRINT,
				root
			});
		},
		async discard() {},
		async markImported() {},
		async beginRun(_operationId, _orgId, at) {
			return at;
		},
		async endRun() {}
	};
	const lookup =
		options.lookup ?? (async () => ({ ttl: 3600, names: [], addresses: [PUBLIC_IP] }));
	const deps = {
		imports,
		connector,
		dump: createDumpStream(connector, store.blobs),
		converter,
		blobs: store.blobs,
		dns: { lookup },
		now: () => 1_700_000_000_000,
		partBytes: options.partBytes ?? 64
	};
	return { server, store, opened, source: createCutoverSource(deps, REF, ORG), deps };
}

const key = (label: string) => `${OP}:${label}`;

describe('cutover keys and markers', () => {
	it('reads a source ref as a credential and a folder', () => {
		expect(parseSourceRef(REF)).toEqual({ credentialId: CREDENTIAL_ID, root: ROOT });
		for (const bad of [
			'source-1',
			CREDENTIAL_ID,
			`${CREDENTIAL_ID}relative`,
			`${CREDENTIAL_ID}/a b`,
			''
		]) {
			expect(parseSourceRef(bad)).toBeNull();
		}
	});

	it('splits a key into the operation and the step', () => {
		expect(keyParts(key('snapshot'))).toEqual({ operationId: OP, label: 'snapshot' });
		expect(keyParts(OP).label).toBe('');
		expect(() => keyParts('../x:snapshot')).toThrow(PermanentError);
	});

	it('refuses a marker this move did not make and a key part that is not an id', () => {
		expect(parseMarker('final-delta:0123456789abcdef').label).toBe('final-delta');
		expect(() => parseMarker('snapshot:xyz')).toThrow(PermanentError);
		expect(() => cutoverKeys.prefix('a/b', OP)).toThrow(PermanentError);
	});
});

describe('the source adapter', () => {
	it('takes a snapshot into parts, writes the manifest last and answers a marker', async () => {
		const { source, store, opened, server } = sourceWorld({ rows: ['a', 'b'] });
		const { marker } = await source.snapshot(key('snapshot'));
		expect(marker).toMatch(/^snapshot:[0-9a-f]{16}$/);
		expect(opened).toEqual([{ credentialId: CREDENTIAL_ID, orgId: ORG, root: ROOT }]);
		expect(server.streams).toEqual([
			`cd '${ROOT}' && drush sql:dump --extra-dump=--hex-blob --structure-tables-list='cache*','key_value_expire','sessions','semaphore','flood','queue','batch','watchdog'`
		]);
		const found = await manifestOfMarker(store.blobs, ORG, OP, marker);
		expect(found?.manifest.parts).toBeGreaterThan(1);
		expect(found?.manifest.tables).toBeNull();
		const copy = await readCopy(store.blobs, found!.copy, found!.manifest);
		expect(new TextDecoder().decode(copy!)).toContain("INSERT INTO `node` VALUES ('b')");
		expect(markerOf(found!.manifest)).toBe(marker);
	});

	it('answers a repeat from the manifest without opening a session', async () => {
		const { source, server } = sourceWorld();
		const first = await source.snapshot(key('snapshot'));
		const sessions = server.sessions;
		expect(await source.snapshot(key('snapshot'))).toEqual(first);
		expect(server.sessions).toBe(sessions);
	});

	it('leaves no manifest after a stream that dropped, and the next try succeeds', async () => {
		const { source, store, server } = sourceWorld({ dropStreams: 1 });
		await expect(source.snapshot(key('snapshot'))).rejects.toThrow();
		expect(
			await store.blobs.get(cutoverKeys.manifest(cutoverKeys.copy(ORG, OP, 'snapshot')))
		).toBeNull();
		const { marker } = await source.snapshot(key('snapshot'));
		expect(marker).toMatch(/^snapshot:/);
		expect(server.streams).toHaveLength(2);
	});

	it('refuses an empty dump', async () => {
		const { source } = sourceWorld({ emptyDump: true });
		const failure = await failureOf(source.snapshot(key('snapshot')));
		expect(failure).toMatchObject({ code: 'dump_empty' });
	});

	it('dumps only the authoritative tables that exist, and adds the id re-seed', async () => {
		const { source, store, server } = sourceWorld();
		const { marker: snap } = await source.snapshot(key('snapshot'));
		const { marker } = await source.delta(key('capture-delta'), snap);
		expect(marker).toMatch(/^capture-delta:/);
		const command = server.streams.at(-1)!;
		expect(command).toContain("--tables-list='node','node_field_data','sequences','users'");
		for (const left of ['sessions', 'cache_default', 'watchdog']) {
			expect(command).not.toContain(`'${left}'`);
		}
		const found = await manifestOfMarker(store.blobs, ORG, OP, marker);
		expect(found?.manifest.tables).toEqual(['node', 'node_field_data', 'sequences', 'users']);
		const sql = new TextDecoder().decode(
			(await readCopy(store.blobs, found!.copy, found!.manifest))!
		);
		expect(sql).toContain('UPDATE sequences SET value');
	});

	it('keeps the capture and the final delta apart and sees a late write only in the final one', async () => {
		const { source, store, server } = sourceWorld();
		const { marker: snap } = await source.snapshot(key('snapshot'));
		const { marker: first } = await source.delta(key('capture-delta'), snap);
		server.rows.push('late');
		const { marker: last } = await source.delta(key('final-delta'), first);
		expect(last).not.toBe(first);
		const body = async (marker: string) => {
			const found = (await manifestOfMarker(store.blobs, ORG, OP, marker))!;
			return new TextDecoder().decode(
				(await readCopy(store.blobs, found.copy, found.manifest))!
			);
		};
		expect(await body(first)).not.toContain('late');
		expect(await body(last)).toContain("VALUES ('late')");
	});

	it('refuses a delta that builds on a marker it does not hold, or on the wrong step key', async () => {
		const { source } = sourceWorld();
		expect(
			await failureOf(source.delta(key('capture-delta'), 'snapshot:0123456789abcdef'))
		).toMatchObject({ code: 'marker_unknown', message: SOURCE_REFUSALS.markerUnknown });
		expect(
			await failureOf(source.delta(key('snapshot'), 'snapshot:0123456789abcdef'))
		).toMatchObject({ code: 'cutover_key' });
	});

	it('refuses a delta when the server lists none of the tables', async () => {
		const { source } = sourceWorld({ tables: ['cache_default'] });
		const { marker } = await source.snapshot(key('snapshot'));
		expect(await failureOf(source.delta(key('capture-delta'), marker))).toMatchObject({
			code: 'source_command'
		});
	});

	it('fails the delta when a command exits non-zero', async () => {
		const { source, server } = sourceWorld();
		const { marker } = await source.snapshot(key('snapshot'));
		server.tables = [];
		server.commands.length = 0;
		const failure = await failureOf(source.delta(key('capture-delta'), marker));
		expect(failure).toBeInstanceOf(PermanentError);
	});

	it.each(['freeze', 'delta'] as const)(
		'holds writes with maintenance mode for %s',
		async (policy) => {
			const { source, server } = sourceWorld();
			await source.applyWritePolicy(key('apply-write-policy'), policy);
			expect(server.maintenance).toBe('1');
			await source.restoreWrites(key('restore-writes'));
			expect(server.maintenance).toBe('');
			expect(server.commands.some((command) => command.includes('state:delete'))).toBe(true);
		}
	);

	it('puts back the value the owner had, even after a repeat of the policy', async () => {
		const { source, server } = sourceWorld({ maintenance: '0' });
		await source.applyWritePolicy(key('apply-write-policy'), 'freeze');
		await source.applyWritePolicy(key('apply-write-policy'), 'freeze');
		await source.restoreWrites(key('restore-writes'));
		expect(server.maintenance).toBe('0');
	});

	it('sends nothing on a second restore and on a restore that follows no policy', async () => {
		const { source, server } = sourceWorld();
		await source.restoreWrites(key('restore-writes'));
		expect(server.sessions).toBe(0);
		await source.applyWritePolicy(key('apply-write-policy'), 'freeze');
		await source.restoreWrites(key('restore-writes'));
		const sessions = server.sessions;
		await source.restoreWrites(key('restore-writes'));
		expect(server.sessions).toBe(sessions);
	});

	it('refuses a policy the server did not hold and a restore that did not take', async () => {
		const world = sourceWorld({ ignoreSet: true });
		expect(
			await failureOf(world.source.applyWritePolicy(key('apply-write-policy'), 'freeze'))
		).toMatchObject({
			code: 'policy_not_held',
			message: SOURCE_REFUSALS.policyNotHeld
		});
		const back = sourceWorld({ maintenance: '' });
		await back.source.applyWritePolicy(key('apply-write-policy'), 'freeze');
		back.server.ignoreSet = true;
		expect(await failureOf(back.source.restoreWrites(key('restore-writes')))).toMatchObject({
			code: 'writes_not_back'
		});
	});

	it('refuses read only before it changes anything when the module is missing', async () => {
		const { source, server, store } = sourceWorld();
		expect(
			await failureOf(source.applyWritePolicy(key('apply-write-policy'), 'read-only'))
		).toMatchObject({
			code: 'read_only_unavailable',
			message: SOURCE_REFUSALS.readOnlyUnavailable
		});
		expect(server.maintenance).toBe('');
		expect(store.objects.size).toBe(0);
	});

	it('sets and restores read only when the module is there', async () => {
		const { source, server } = sourceWorld({ modules: ['node', 'readonlymode'] });
		await source.applyWritePolicy(key('apply-write-policy'), 'read-only');
		expect(server.readOnly).toBe('true');
		await source.restoreWrites(key('restore-writes'));
		expect(server.readOnly).toBe('false');
	});

	it('keeps read only on when the owner already had it on', async () => {
		const { source, server } = sourceWorld({ modules: ['readonlymode'], readOnly: 'true' });
		await source.applyWritePolicy(key('apply-write-policy'), 'read-only');
		await source.restoreWrites(key('restore-writes'));
		expect(server.readOnly).toBe('true');
	});

	it('reads the cache time and never lowers it', async () => {
		const world = sourceWorld();
		expect(await world.source.lowerTtl(key('lower-ttl'), HOSTNAME, 60)).toEqual({
			previousTtlSeconds: 3600
		});
		expect(await world.source.lowerTtl(key('lower-ttl'), HOSTNAME, 7200)).toEqual({
			previousTtlSeconds: 7200
		});
		await expect(
			world.source.restoreTtl(key('restore-ttl'), HOSTNAME, 3600)
		).resolves.toBeUndefined();
		expect(world.server.sessions).toBe(0);
	});

	it('refuses an address with no records and retries one that did not answer', async () => {
		const none = sourceWorld(
			{},
			{ lookup: async () => ({ ttl: null, names: [], addresses: [] }) }
		);
		expect(await failureOf(none.source.lowerTtl(key('lower-ttl'), HOSTNAME, 60))).toMatchObject(
			{
				code: 'no_dns_records'
			}
		);
		const down = sourceWorld({}, { lookup: async () => Promise.reject(new Error('timeout')) });
		const failure = await failureOf(down.source.lowerTtl(key('lower-ttl'), HOSTNAME, 60));
		expect(failure).not.toBeInstanceOf(PermanentError);
	});

	it('passes a credential refusal through at the first use and at the restore', async () => {
		const expired = new PermanentError(
			'credential_expired',
			'the import credential has expired'
		);
		const world = sourceWorld({}, { refuse: expired });
		expect(await failureOf(world.source.snapshot(key('snapshot')))).toBe(expired);
		const policy = sourceWorld();
		await policy.source.applyWritePolicy(key('apply-write-policy'), 'freeze');
		const later = createCutoverSource(
			{
				...policy.deps,
				imports: {
					...policy.deps.imports,
					withTarget: async () => {
						throw expired;
					}
				}
			},
			REF,
			ORG
		);
		expect(await failureOf(later.restoreWrites(key('restore-writes')))).toBe(expired);
	});

	it('refuses a ref it cannot read on the first call that needs the server', async () => {
		const { deps } = sourceWorld();
		const source = createCutoverSource(deps, 'source-1', ORG);
		expect(await failureOf(source.snapshot(key('snapshot')))).toMatchObject({
			code: 'source_ref'
		});
	});

	it('never shows the key or the server text in what it throws', async () => {
		const { source } = sourceWorld({ emptyDump: true });
		const failure = await failureOf(source.snapshot(key('snapshot')));
		expect(failure.message).not.toContain(KEY_MARKER);
	});
});

// #region the new site

function destinationWorld(
	patch: {
		site?: Partial<BackupSite> | null;
		status?: number;
		states?: ImportState[];
		ceiling?: number;
		lookups?: (hostname: string) => DnsLookup | Error;
		routeWaitMs?: number;
	} = {}
) {
	const store = fakeBlobs();
	const log: string[] = [];
	const bodies: string[] = [];
	let clock = 0;
	const states = [...(patch.states ?? ['absent', 'applied'])];
	let last: ImportState = 'absent';
	const site: BackupSite | null =
		patch.site === null
			? null
			: {
					id: SITE,
					organizationId: ORG,
					accountId: 'acct_1',
					plane: 'managed',
					state: 'active',
					primaryHostname: NEW_ADDRESS,
					adoptedTo: null,
					...patch.site
				};
	const lookups =
		patch.lookups ??
		((hostname: string): DnsLookup =>
			hostname === NEW_ADDRESS
				? { ttl: 60, names: [], addresses: ['198.51.100.9'] }
				: { ttl: 60, names: [NEW_ADDRESS], addresses: ['198.51.100.9'] });
	const destination = createCutoverDestination(
		{
			backups: { site: async () => site },
			custody: {
				sealed: async () => ({ ownerTokenId: 'tok_1', pendingSecretId: null }),
				withOwnerToken: async (_site, _token, use) => use('owner-token-value')
			},
			worker: {
				async restore(hostname, body, label) {
					log.push(`restore ${hostname} ${label}`);
					bodies.push(new TextDecoder().decode(body));
					return { chunks: 1, statements: 1 };
				},
				async importState() {
					last = states.length > 0 ? states.shift()! : last;
					log.push(`state ${last}`);
					return last;
				},
				async importReason() {
					return '';
				}
			},
			site: {
				async probe(hostname, path, _expect, auth) {
					log.push(
						`probe ${hostname}${path} ${auth?.bearer === undefined ? 'open' : 'owner'}`
					);
					return { status: patch.status ?? 200 };
				}
			},
			blobs: store.blobs,
			dns: {
				async lookup(hostname) {
					const answer = lookups(hostname);
					if (answer instanceof Error) throw answer;
					return answer;
				}
			},
			sleep: async (ms) => {
				clock += ms;
				log.push(`sleep ${ms}`);
			},
			now: () => clock,
			ceilingBytes: patch.ceiling,
			applyWaitMs: 10_000,
			applyPollMs: 1_000,
			routeWaitMs: patch.routeWaitMs ?? 60_000,
			routePollMs: 15_000
		},
		SITE
	);
	return { destination, store, log, bodies, setSite: () => site };
}

async function plantCopy(
	store: ReturnType<typeof fakeBlobs>,
	label: 'snapshot' | 'capture-delta' | 'final-delta',
	sql: string,
	tables: string[] | null
): Promise<string> {
	const copy = cutoverKeys.copy(ORG, OP, label);
	const bytes = new TextEncoder().encode(sql);
	await store.blobs.put(partKey(cutoverKeys.sql(copy), 0, 'sql'), bytes);
	const digest = await digestOfParts([await sha256Hex(bytes)]);
	await writeManifest(store.blobs, copy, {
		label,
		parts: 1,
		bytes: bytes.byteLength,
		digest,
		tables,
		takenAt: 0
	});
	return `${label}:${digest.slice(0, 16)}`;
}

// the source side, over the fake server, lays the copies the destination reads
async function copiesOf(store: ReturnType<typeof fakeBlobs>, rows: string[] = []) {
	const world = sourceWorld({ rows });
	const snapshot = await world.source.snapshot(key('snapshot'));
	const capture = await world.source.delta(key('capture-delta'), snapshot.marker);
	for (const [name, bytes] of world.store.objects) store.objects.set(name, bytes);
	return { snapshot: snapshot.marker, delta: capture.marker, world };
}

describe('the destination adapter', () => {
	it('answers null when the site is live and both copies read back whole', async () => {
		const world = destinationWorld();
		const { snapshot, delta } = await copiesOf(world.store);
		expect(await world.destination.validate(key('validate'), snapshot, delta)).toBeNull();
		expect(world.log).toContain(`probe ${NEW_ADDRESS}/health owner`);
	});

	it('names each plain problem', async () => {
		const gone = destinationWorld({ site: null });
		expect(await gone.destination.validate(key('validate'), 'x', 'y')).toBe(
			DESTINATION_REFUSALS.notLive
		);
		const idle = destinationWorld({ site: { state: 'suspended' } });
		expect(await idle.destination.validate(key('validate'), 'x', 'y')).toBe(
			DESTINATION_REFUSALS.notLive
		);
		const silent = destinationWorld({ status: 503 });
		const a = await copiesOf(silent.store);
		expect(await silent.destination.validate(key('validate'), a.snapshot, a.delta)).toBe(
			DESTINATION_REFUSALS.notAnswering
		);
		const lost = destinationWorld();
		expect(
			await lost.destination.validate(
				key('validate'),
				'snapshot:0123456789abcdef',
				'capture-delta:0123456789abcdef'
			)
		).toBe(DESTINATION_REFUSALS.copyMissing);
		const swapped = destinationWorld();
		const b = await copiesOf(swapped.store);
		expect(await swapped.destination.validate(key('validate'), b.delta, b.snapshot)).toBe(
			DESTINATION_REFUSALS.copyMissing
		);
		const damaged = destinationWorld();
		const c = await copiesOf(damaged.store);
		const copy = cutoverKeys.copy(ORG, OP, 'snapshot');
		damaged.store.objects.set(
			partKey(cutoverKeys.sql(copy), 0, 'sql'),
			new TextEncoder().encode('x')
		);
		expect(await damaged.destination.validate(key('validate'), c.snapshot, c.delta)).toBe(
			DESTINATION_REFUSALS.copyMissing
		);
		const big = destinationWorld({ ceiling: 10 });
		const d = await copiesOf(big.store);
		expect(await big.destination.validate(key('validate'), d.snapshot, d.delta)).toBe(
			DESTINATION_REFUSALS.tooLarge
		);
	});

	it('refuses a change copy that writes a table it does not carry', async () => {
		const world = destinationWorld();
		const snapshot = await plantCopy(world.store, 'snapshot', NODE_TABLE, null);
		const inside = await plantCopy(world.store, 'capture-delta', NODE_TABLE, ['node']);
		expect(await world.destination.validate(key('validate'), snapshot, inside)).toBeNull();
		const outside = await plantCopy(
			world.store,
			'final-delta',
			`${NODE_TABLE}DROP TABLE IF EXISTS \`sessions\`;\n`,
			['node']
		);
		expect(await world.destination.validate(key('validate'), snapshot, outside)).toBe(
			DESTINATION_REFUSALS.deltaScope
		);
	});

	it('lists the tables a copy writes to', () => {
		expect(
			tablesTouched(
				'DROP TABLE IF EXISTS `a`;\nCREATE TABLE "b" (x int);\nINSERT INTO c VALUES (1);\nINSERT OR REPLACE INTO d VALUES (2);\nSELECT 1;'
			)
		).toEqual(['a', 'b', 'c', 'd']);
	});

	it('sends the snapshot, the changes and the re-seed once, and waits for the site to apply them', async () => {
		const world = destinationWorld({ states: ['absent', 'pending', 'pending', 'applied'] });
		const { snapshot, delta } = await copiesOf(world.store, ['kept']);
		await world.destination.promote(key('promote'), snapshot, delta);
		expect(world.log.filter((line) => line.startsWith('restore'))).toEqual([
			`restore ${NEW_ADDRESS} promote-${OP}`
		]);
		expect(world.log.filter((line) => line.startsWith('sleep'))).toHaveLength(2);
		expect(world.bodies[0]).toContain("INSERT INTO `node` VALUES ('kept')");
		expect(world.bodies[0]!.trimEnd().endsWith(';')).toBe(true);
		expect(world.bodies[0]).toContain('UPDATE sequences SET value');
	});

	it('sends nothing again when a repeat finds the data already applied', async () => {
		const world = destinationWorld({ states: ['applied'] });
		const { snapshot, delta } = await copiesOf(world.store);
		await world.destination.promote(key('promote'), snapshot, delta);
		expect(world.log.some((line) => line.startsWith('restore'))).toBe(false);
	});

	it('fails a promote the site could not apply and retries one that is still pending', async () => {
		const failed = destinationWorld({ states: ['absent', 'failed'] });
		const a = await copiesOf(failed.store);
		expect(
			await failureOf(failed.destination.promote(key('promote'), a.snapshot, a.delta))
		).toMatchObject({
			code: 'promote_failed',
			message: DESTINATION_REFUSALS.notApplied
		});
		const slow = destinationWorld({ states: ['absent', 'pending'] });
		const b = await copiesOf(slow.store);
		const failure = await failureOf(
			slow.destination.promote(key('promote'), b.snapshot, b.delta)
		);
		expect(failure).not.toBeInstanceOf(PermanentError);
	});

	it('refuses to promote copies that do not check out, and a site that is not live', async () => {
		const world = destinationWorld();
		expect(
			await failureOf(
				world.destination.promote(
					key('promote'),
					'snapshot:0123456789abcdef',
					'final-delta:0123456789abcdef'
				)
			)
		).toMatchObject({ code: 'promote_refused', message: DESTINATION_REFUSALS.copyMissing });
		const gone = destinationWorld({ site: null });
		expect(await failureOf(gone.destination.promote(key('promote'), 'a', 'b'))).toMatchObject({
			code: 'destination_not_live'
		});
	});

	it('sees the address point at the new site, at once and after a wait', async () => {
		const world = destinationWorld();
		await world.destination.route(key('route'), 'destination', HOSTNAME);
		expect(world.log.filter((line) => line.startsWith('sleep'))).toHaveLength(0);
		let reads = 0;
		const slow = destinationWorld({
			lookups: (hostname) => {
				if (hostname === NEW_ADDRESS)
					return { ttl: 60, names: [], addresses: ['198.51.100.9'] };
				reads++;
				return reads < 3
					? { ttl: 60, names: [], addresses: ['203.0.113.7'] }
					: { ttl: 60, names: [NEW_ADDRESS], addresses: [] };
			}
		});
		await slow.destination.route(key('route'), 'destination', HOSTNAME);
		expect(slow.log.filter((line) => line.startsWith('sleep'))).toHaveLength(2);
	});

	it('accepts a shared address as pointing at the new site', async () => {
		const world = destinationWorld({
			lookups: (hostname) => ({
				ttl: 60,
				names: [],
				addresses: hostname === NEW_ADDRESS ? ['198.51.100.9'] : ['198.51.100.9']
			})
		});
		await world.destination.route(key('route'), 'destination', HOSTNAME);
	});

	it('gives up on an address that never moved, and on one it could not read', async () => {
		const stuck = destinationWorld({
			lookups: (hostname) =>
				hostname === NEW_ADDRESS
					? { ttl: 60, names: [], addresses: ['198.51.100.9'] }
					: { ttl: 60, names: [], addresses: ['203.0.113.7'] }
		});
		expect(
			await failureOf(stuck.destination.route(key('route'), 'destination', HOSTNAME))
		).toMatchObject({
			code: 'route_not_seen'
		});
		const dark = destinationWorld({ lookups: () => new Error('timeout') });
		const failure = await failureOf(
			dark.destination.route(key('route'), 'destination', HOSTNAME)
		);
		expect(failure).not.toBeInstanceOf(PermanentError);
	});

	it('waits for the address to leave the new site when going back', async () => {
		const world = destinationWorld({
			lookups: (hostname) =>
				hostname === NEW_ADDRESS
					? { ttl: 60, names: [], addresses: ['198.51.100.9'] }
					: { ttl: 60, names: [], addresses: ['203.0.113.7'] }
		});
		await world.destination.route(key('route-back'), 'source', HOSTNAME);
		const still = destinationWorld();
		expect(
			await failureOf(still.destination.route(key('route-back'), 'source', HOSTNAME))
		).toMatchObject({
			code: 'route_not_seen'
		});
	});

	it('refuses the three calls the released worker cannot answer, naming the missing contract', async () => {
		const world = destinationWorld();
		for (const call of [
			() => world.destination.acceptedWrites(),
			() => world.destination.observe(),
			() => world.destination.exportChanges(key('export-changes'))
		]) {
			expect(await failureOf(call())).toMatchObject({ code: 'worker_contract_missing' });
		}
		expect(CUTOVER_MISSING_CONTRACTS.length).toBeGreaterThan(0);
	});
});

// #endregion

describe('the dns reader', () => {
	const answer = (body: unknown, ok = true) =>
		(async () => ({
			ok,
			status: ok ? 200 : 502,
			json: async () => body
		})) as unknown as typeof fetch;

	it('reads the smallest cache time, the CNAME names and the addresses', async () => {
		const reader = dohReader(
			answer({
				Status: 0,
				Answer: [
					{ type: 5, TTL: 300, data: 'New-Site.drupflare.app.' },
					{ type: 1, TTL: 120, data: '198.51.100.9' }
				]
			})
		);
		expect(await reader.lookup(HOSTNAME)).toEqual({
			ttl: 120,
			names: [NEW_ADDRESS],
			addresses: ['198.51.100.9']
		});
	});

	it('answers no records for a name that does not exist', async () => {
		expect(await dohReader(answer({ Status: 3 })).lookup(HOSTNAME)).toEqual({
			ttl: null,
			names: [],
			addresses: []
		});
	});

	it('throws when the resolver errors or does not answer', async () => {
		await expect(dohReader(answer({}, false)).lookup(HOSTNAME)).rejects.toThrow('answered 502');
		const down = (async () => {
			throw new Error('socket');
		}) as unknown as typeof fetch;
		await expect(dohReader(down).lookup(HOSTNAME)).rejects.toThrow('did not answer');
	});

	it('compares a moving name with the new site by CNAME or by address', async () => {
		const table: Record<string, DnsLookup> = {
			[HOSTNAME]: { ttl: 60, names: [], addresses: ['1.1.1.1'] },
			[NEW_ADDRESS]: { ttl: 60, names: [], addresses: ['2.2.2.2'] }
		};
		const reader = { lookup: async (name: string) => table[name]! };
		expect(await pointsAt(reader, HOSTNAME, NEW_ADDRESS)).toBe(false);
		table[HOSTNAME] = { ttl: 60, names: [NEW_ADDRESS], addresses: [] };
		expect(await pointsAt(reader, HOSTNAME, NEW_ADDRESS)).toBe(true);
		table[HOSTNAME] = { ttl: 60, names: [], addresses: ['2.2.2.2'] };
		expect(await pointsAt(reader, HOSTNAME, NEW_ADDRESS)).toBe(true);
	});
});

describe('cutoverPortsOf', () => {
	it('hands the organization to the source and the site to the destination', async () => {
		const world = sourceWorld();
		const dest = destinationWorld();
		const ports = cutoverPortsOf({
			...world.deps,
			backups: { site: async () => dest.setSite() },
			custody: {
				sealed: async () => ({ ownerTokenId: 'tok_1', pendingSecretId: null }),
				withOwnerToken: async (_a, _b, use) => use('t')
			},
			worker: {
				restore: async () => ({ chunks: 1, statements: 1 }),
				importState: async () => 'applied' as ImportState,
				importReason: async () => ''
			},
			site: { probe: async () => ({ status: 200 }) },
			sleep: async () => {}
		});
		await ports.source(REF, ORG).snapshot(key('snapshot'));
		expect(world.opened[0]?.orgId).toBe(ORG);
		await expect(ports.destination(SITE).acceptedWrites()).rejects.toThrow();
	});
});
