import { describe, expect, it } from 'vitest';
import { ChangeScan } from '../../../engine/src/adapters/change-scan';
import { cutoverPortsOf } from '../../../engine/src/adapters/cutover';
import {
	countFrom,
	createCutoverDestination,
	CUTOVER_MISSING_CONTRACTS,
	DESTINATION_REFUSALS,
	exportNotes,
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
	markOf,
	parseMarker,
	parseSourceRef,
	readCopy,
	sha256Hex,
	writeManifest
} from '../../../engine/src/adapters/cutover-store';
import { createDumpStream, type StreamConnector } from '../../../engine/src/adapters/dump-stream';
import type { SshConnector } from '../../../engine/src/adapters/ssh-survey';
import { writeMarkWorkerOf } from '../../../engine/src/adapters/write-mark';
import { partKey } from '../../../engine/src/import-parts';
import type { BackupSite, ImportState, ImportStore, SqlConverter } from '../../../engine/src/ports';
import { PermanentError } from '../../../engine/src/step';
import { fakeBlobs } from './backup-fakes';
import { changeBody, fakeMarks, type MarksOptions } from './cutover-fakes';
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
	},
	async scanPg() {
		throw new Error('the cutover source reads MySQL dumps only');
	},
	async schemaPg() {
		throw new Error('the cutover source reads MySQL dumps only');
	},
	async dataPg() {
		throw new Error('the cutover source reads MySQL dumps only');
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
		marks?: MarksOptions;
		partBytes?: number;
		changesLimitBytes?: number;
		windowWrites?: number;
		// what the site's restore does with a mark id: open it, say it will and lose it, or ignore it
		restoreMark?: 'opens' | 'echoes' | 'ignores';
	} = {}
) {
	const store = fakeBlobs();
	const asked: (string | undefined)[] = [];
	const marks = fakeMarks(patch.marks);
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
				async restore(hostname, body, label, _auth, mark) {
					log.push(`restore ${hostname} ${label}`);
					bodies.push(new TextDecoder().decode(body));
					asked.push(mark);
					const mode = patch.restoreMark ?? 'ignores';
					if (mode === 'ignores' || mark === undefined)
						return { chunks: 1, statements: 1 };
					if (mode === 'opens') {
						marks.state.mark = mark;
						marks.state.writes = 0;
					}
					return { chunks: 1, statements: 1, mark };
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
			marks: marks.worker,
			partBytes: patch.partBytes,
			changesLimitBytes: patch.changesLimitBytes,
			windowWrites: patch.windowWrites,
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
	return { destination, store, log, bodies, marks, asked, setSite: () => site };
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

	it('asks the site to open the count with the copy and reports it open', async () => {
		const world = destinationWorld({ restoreMark: 'opens' });
		const { snapshot, delta } = await copiesOf(world.store);
		const out = await world.destination.promote(key('promote'), snapshot, delta);
		expect(out).toEqual({ counting: true });
		expect(world.asked).toEqual([markOf(OP)]);
		expect(world.marks.state).toMatchObject({ mark: markOf(OP), writes: 0, starts: 0 });
		expect(world.marks.state.calls).not.toContain('start');
	});

	it('reports the count closed when the site predates the field, so the caller starts it', async () => {
		const world = destinationWorld({ restoreMark: 'ignores' });
		const { snapshot, delta } = await copiesOf(world.store);
		expect(await world.destination.promote(key('promote'), snapshot, delta)).toEqual({
			counting: false
		});
		expect(world.asked).toEqual([markOf(OP)]);
		expect(world.marks.state.calls).not.toContain('read');
	});

	it('reports the count closed when the site said it would open it and has none', async () => {
		const world = destinationWorld({ restoreMark: 'echoes' });
		const { snapshot, delta } = await copiesOf(world.store);
		expect(await world.destination.promote(key('promote'), snapshot, delta)).toEqual({
			counting: false
		});
		expect(world.marks.state.calls).toContain('read');
	});

	it('reports the count closed when another move holds the count', async () => {
		const world = destinationWorld({
			restoreMark: 'echoes',
			marks: { mark: 'cutover-op_other' }
		});
		const { snapshot, delta } = await copiesOf(world.store);
		expect(await world.destination.promote(key('promote'), snapshot, delta)).toEqual({
			counting: false
		});
	});

	it('finds the count open on a replay after the copy was applied, and keeps its tally', async () => {
		const world = destinationWorld({
			states: ['applied'],
			marks: { mark: markOf(OP), writes: 4 }
		});
		const { snapshot, delta } = await copiesOf(world.store);
		expect(await world.destination.promote(key('promote'), snapshot, delta)).toEqual({
			counting: true
		});
		expect(world.asked).toEqual([]);
		expect(world.marks.state.writes).toBe(4);
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

	it('leaves no contract missing, so the start opens', () => {
		expect(CUTOVER_MISSING_CONTRACTS).toEqual([]);
	});

	it('tells the owner a site without the count routes needs an update before the move', async () => {
		const world = destinationWorld({ marks: { supported: false } });
		const { snapshot, delta } = await copiesOf(world.store);
		expect(await world.destination.validate(key('validate'), snapshot, delta)).toBe(
			DESTINATION_REFUSALS.needsUpdate
		);
		expect(DESTINATION_REFUSALS.needsUpdate).not.toMatch(/contract|worker|route/i);
	});
});

// #region counting writes

describe('the mark of a move', () => {
	it('is stable for one move and differs between moves', () => {
		const other = `op_${'q'.repeat(26)}`;
		expect(markOf(OP)).toBe(markOf(keyParts(key('promote')).operationId));
		expect(markOf(OP)).not.toBe(markOf(other));
		expect(markOf(OP)).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
	});

	it('refuses an operation id the site would reject', () => {
		expect(() => markOf('x'.repeat(80))).toThrow(PermanentError);
	});
});

describe('judging a count', () => {
	const mark = markOf(OP);

	it('reads zero, one and many from a site that answered with our mark', () => {
		for (const writes of [0, 1, 40]) {
			expect(countFrom({ mark, writes, incomplete: null }, mark)).toEqual({ writes });
		}
	});

	it('keeps a count a failed capture or a full journal left above zero', () => {
		expect(countFrom({ mark, writes: 3, incomplete: 'journal_full' }, mark)).toEqual({
			writes: 3
		});
		expect(countFrom({ mark, writes: 1, incomplete: 'capture_failed' }, mark)).toEqual({
			writes: 1
		});
	});

	it('never reads zero from a missing mark, a missing route, another mark or a failed capture', () => {
		const lost = { problem: DESTINATION_REFUSALS.countLost };
		expect(countFrom('none', mark)).toEqual(lost);
		expect(countFrom('missing', mark)).toEqual(lost);
		expect(countFrom({ mark: 'cutover-other', writes: 0, incomplete: null }, mark)).toEqual(
			lost
		);
		expect(countFrom({ mark, writes: 0, incomplete: 'capture_failed' }, mark)).toEqual(lost);
	});
});

describe('the destination count', () => {
	it('starts once however often the promote step replays', async () => {
		const world = destinationWorld();
		await world.destination.startCounting(key('promote'));
		world.marks.state.writes = 4;
		await world.destination.startCounting(key('promote'));
		expect(world.marks.state.starts).toBe(1);
		expect(world.marks.state.writes).toBe(4);
		expect(world.marks.state.mark).toBe(markOf(OP));
	});

	it('refuses to start over another move, or on a site without the routes', async () => {
		const taken = destinationWorld({ marks: { mark: 'cutover-op_other' } });
		expect(await failureOf(taken.destination.startCounting(key('promote')))).toMatchObject({
			code: 'write_count_not_started'
		});
		const old = destinationWorld({ marks: { supported: false } });
		expect(await failureOf(old.destination.startCounting(key('promote')))).toMatchObject({
			code: 'write_count_not_started'
		});
		expect(taken.marks.state.mark).toBe('cutover-op_other');
	});

	it('retries a start the site answered with a failure', async () => {
		const world = destinationWorld({ marks: { fail: { start: 1 } } });
		expect(await failureOf(world.destination.startCounting(key('promote')))).not.toBeInstanceOf(
			PermanentError
		);
		await world.destination.startCounting(key('promote'));
		expect(world.marks.state.starts).toBe(1);
	});

	it('counts zero, then the writes that arrive', async () => {
		const world = destinationWorld();
		await world.destination.startCounting(key('promote'));
		expect(await world.destination.acceptedWrites(key('write-mark'))).toBe(0);
		world.marks.state.writes = 2;
		expect(await world.destination.acceptedWrites(key('write-mark'))).toBe(2);
		world.marks.state.writes = 9;
		expect(await world.destination.observe(key('write-mark'))).toEqual({
			healthy: true,
			writes: 9
		});
	});

	it('reports a site that fails its health check with the count it holds', async () => {
		const world = destinationWorld({ status: 503, marks: { mark: markOf(OP), writes: 5 } });
		expect(await world.destination.observe(key('write-mark'))).toEqual({
			healthy: false,
			writes: 5
		});
	});

	it('never reads a failure as zero writes', async () => {
		const flaky = destinationWorld({ marks: { fail: { read: 2 } } });
		await flaky.destination.startCounting(key('promote'));
		for (let attempt = 0; attempt < 2; attempt++) {
			const failure = await failureOf(flaky.destination.acceptedWrites(key('write-mark')));
			expect(failure).not.toBeInstanceOf(PermanentError);
		}
		expect(await flaky.destination.acceptedWrites(key('write-mark'))).toBe(0);
	});

	it('surfaces a count that disappeared after the start', async () => {
		const world = destinationWorld();
		await world.destination.startCounting(key('promote'));
		world.marks.state.mark = null;
		expect(await failureOf(world.destination.acceptedWrites(key('write-mark')))).toMatchObject({
			code: 'write_count_lost'
		});
		expect(await failureOf(world.destination.observe(key('write-mark')))).toMatchObject({
			code: 'write_count_lost'
		});
		world.marks.state.supported = false;
		expect(await failureOf(world.destination.acceptedWrites(key('write-mark')))).toMatchObject({
			code: 'write_count_lost'
		});
	});

	it('ends the count, and a repeat ends nothing more', async () => {
		const world = destinationWorld();
		await world.destination.startCounting(key('promote'));
		await world.destination.stopCounting(key('write-mark'));
		await world.destination.stopCounting(key('write-mark'));
		expect(world.marks.state.ends).toBe(1);
		expect(world.marks.state.mark).toBeNull();
	});
});

describe('the change list scan', () => {
	const read = (...chunks: string[]) => {
		const scan = new ChangeScan();
		for (const chunk of chunks) scan.push(new TextEncoder().encode(chunk));
		return scan.result();
	};
	const reseed = 'UPDATE sequences SET value = 1 WHERE value < 1;\n';

	it('accepts a list whose closing line agrees with what it read', () => {
		const result = read(
			'-- changes through write 2, mysql\n',
			'REPLACE INTO `node` (`nid`) VALUES (1);\nDELETE FROM `node` WHERE `nid` = 3;\n',
			reseed,
			'-- end, 2 statements\n'
		);
		expect(result).toEqual({ statements: 2, declared: 2, complete: true });
	});

	it('counts a statement whose text spans lines and holds semicolons', () => {
		const text = "REPLACE INTO `node__body` (`body`) VALUES ('a;\nb''c\\' ;\nd');\n";
		expect(read(text, '-- end, 1 statement\n').complete).toBe(true);
	});

	it('reads the same result however the stream is cut', () => {
		const whole = `-- changes\nREPLACE INTO \`t\` (\`a\`) VALUES ('x;y');\n${reseed}-- end, 1 statement\n`;
		for (let cut = 1; cut < whole.length; cut += 7) {
			expect(read(whole.slice(0, cut), whole.slice(cut)).complete).toBe(true);
		}
	});

	it('rejects a list with no closing line, and one that disagrees', () => {
		expect(read('REPLACE INTO `t` (`a`) VALUES (1);\n').complete).toBe(false);
		expect(
			read('REPLACE INTO `t` (`a`) VALUES (1);\n', '-- end, 2 statements\n')
		).toMatchObject({
			statements: 1,
			declared: 2,
			complete: false
		});
	});

	it('rejects a list cut inside a literal', () => {
		expect(read("REPLACE INTO `t` (`a`) VALUES ('abc").complete).toBe(false);
		expect(read("REPLACE INTO `t` (`a`) VALUES ('abc\n-- end, 0 statements\n").complete).toBe(
			false
		);
	});
});

describe('what the export cannot carry', () => {
	const manifest = (patch: Partial<Parameters<typeof exportNotes>[0]> = {}) => ({
		mark: markOf(OP),
		writes: 3,
		incomplete: null,
		through: 3,
		cannotCarry: [],
		...patch
	});

	it('says it in plain words, with no table name or error code', () => {
		const notes = exportNotes(
			manifest({
				incomplete: 'journal_full',
				cannotCarry: [
					'sessions',
					'settings and state kept in key-value storage',
					'the bytes of 2 new, replaced or removed files',
					'structure changes to webform_submission, node',
					'rows in cache_foo, which has no key to export by',
					'something the site invented for webform_x'
				]
			}),
			0
		);
		const joined = notes.join(' ');
		expect(joined).not.toMatch(/webform|cache_foo|journal_full|key-value storage"/);
		expect(notes[0]).toContain('not a full account');
		expect(notes).toContain('Sign-in sessions');
		expect(notes).toContain(
			'The files themselves (2 new, replaced or removed); only the records of them are saved'
		);
		expect(notes).toContain('Other changes the new site could not describe');
	});

	it('counts the changes that arrived after the file was saved', () => {
		expect(exportNotes(manifest(), 2).at(-1)).toBe(
			'2 changes the new site accepted after the file was saved'
		);
		expect(exportNotes(manifest(), 1).at(-1)).toBe(
			'1 change the new site accepted after the file was saved'
		);
		expect(exportNotes(manifest(), 0).at(-1)).toContain('after the file is saved');
	});
});

describe('exporting the new changes', () => {
	const ONE = ['REPLACE INTO `node` (`nid`) VALUES (1);'];

	async function ready(patch: Parameters<typeof destinationWorld>[0] = {}) {
		const world = destinationWorld(patch);
		await world.destination.startCounting(key('promote'));
		world.marks.state.writes = world.marks.state.writes || 3;
		return world;
	}
	const saved = (world: Awaited<ReturnType<typeof ready>>) =>
		[...world.store.objects.keys()].filter((name) =>
			name.startsWith(cutoverKeys.changes(ORG, OP))
		);

	it('saves a complete list as parts with a manifest and answers what it cannot carry', async () => {
		const world = await ready({
			marks: { bodies: [[changeBody([...ONE, 'DELETE FROM `node` WHERE `nid` = 2;'])]] }
		});
		const result = await world.destination.exportChanges(key('export-changes'), 'mysql');
		expect(result.reference).toBe(cutoverKeys.changes(ORG, OP));
		expect(result.cannotCarry).toContain('Sign-in sessions');
		const prefix = cutoverKeys.changes(ORG, OP);
		const part = world.store.objects.get(partKey(prefix, 0, 'sql'))!;
		expect(new TextDecoder().decode(part)).toContain('-- end, 2 statements');
		const manifest = JSON.parse(
			new TextDecoder().decode(world.store.objects.get(cutoverKeys.manifest(prefix))!)
		);
		expect(manifest).toMatchObject({ parts: 1, statements: 2, through: 3 });
	});

	it('cuts a long list into parts that join back to the whole', async () => {
		const world = await ready({
			partBytes: 40,
			marks: { bodies: [[changeBody([...ONE, ...ONE, ...ONE])]] }
		});
		await world.destination.exportChanges(key('export-changes'), 'mysql');
		const prefix = cutoverKeys.changes(ORG, OP);
		const manifest = JSON.parse(
			new TextDecoder().decode(world.store.objects.get(cutoverKeys.manifest(prefix))!)
		);
		expect(manifest.parts).toBeGreaterThan(1);
		const joined = [...Array(manifest.parts).keys()]
			.map((seq) =>
				new TextDecoder().decode(world.store.objects.get(partKey(prefix, seq, 'sql'))!)
			)
			.join('');
		expect(joined).toBe(changeBody([...ONE, ...ONE, ...ONE]));
		expect(manifest.digest).toBe(
			await digestOfParts(
				await Promise.all(
					[...Array(manifest.parts).keys()].map((seq) =>
						sha256Hex(world.store.objects.get(partKey(prefix, seq, 'sql'))!)
					)
				)
			)
		);
	});

	it('treats a list with no closing line as cut short and starts over on the retry', async () => {
		const world = await ready({
			marks: { bodies: [[changeBody(ONE, null)], [changeBody(ONE)]] }
		});
		const failure = await failureOf(
			world.destination.exportChanges(key('export-changes'), 'mysql')
		);
		expect(failure).not.toBeInstanceOf(PermanentError);
		expect(failure.message).toBe(DESTINATION_REFUSALS.exportCutShort);
		await world.destination.exportChanges(key('export-changes'), 'mysql');
		expect(world.marks.state.bodiesRead).toBe(2);
		const text = [...world.store.objects.entries()]
			.filter(([name]) => name.endsWith('.sql'))
			.map(([, bytes]) => new TextDecoder().decode(bytes))
			.join('');
		expect(text).toBe(changeBody(ONE));
	});

	it('carries an incomplete flag and the limits the site named, in plain words', async () => {
		const world = await ready({
			marks: {
				incomplete: 'journal_full',
				cannotCarry: ['sessions', 'structure changes to webform_submission']
			}
		});
		const { cannotCarry } = await world.destination.exportChanges(
			key('export-changes'),
			'mysql'
		);
		expect(cannotCarry[0]).toContain('not a full account');
		expect(cannotCarry).toContain('Changes to the structure of the database');
		expect(cannotCarry.join(' ')).not.toMatch(/webform|journal_full/);
	});

	it('names the writes that arrived after the list was read', async () => {
		const world = await ready();
		const marks = world.marks.worker;
		const original = marks.body;
		marks.body = async (host, through, auth) => {
			const body = await original(host, through, auth);
			world.marks.state.writes += 2;
			return body;
		};
		const { cannotCarry } = await world.destination.exportChanges(
			key('export-changes'),
			'mysql'
		);
		expect(cannotCarry.at(-1)).toBe('2 changes the new site accepted after the file was saved');
	});

	it('refuses a database that is not MySQL or MariaDB before it calls the site', async () => {
		const world = await ready();
		const before = world.marks.state.calls.length;
		expect(
			await failureOf(world.destination.exportChanges(key('export-changes'), 'pgsql'))
		).toMatchObject({
			code: 'export_dialect'
		});
		expect(world.marks.state.calls.length).toBe(before);
		expect(saved(world)).toEqual([]);
	});

	it('refuses an export when the count is gone or belongs to another move', async () => {
		const gone = await ready();
		gone.marks.state.mark = null;
		expect(
			await failureOf(gone.destination.exportChanges(key('export-changes'), 'mysql'))
		).toMatchObject({
			code: 'write_count_lost'
		});
		const other = await ready();
		other.marks.state.mark = 'cutover-op_other';
		expect(
			await failureOf(other.destination.exportChanges(key('export-changes'), 'mysql'))
		).toMatchObject({
			code: 'write_count_lost'
		});
	});

	it('stops a list that runs past the limit', async () => {
		const world = await ready({ changesLimitBytes: 20 });
		expect(
			await failureOf(world.destination.exportChanges(key('export-changes'), 'mysql'))
		).toMatchObject({
			code: 'export_too_large'
		});
	});

	it('retries a site that answered the manifest with a failure', async () => {
		const world = await ready({ marks: { fail: { manifest: 1 } } });
		expect(
			await failureOf(world.destination.exportChanges(key('export-changes'), 'mysql'))
		).not.toBeInstanceOf(PermanentError);
		await world.destination.exportChanges(key('export-changes'), 'mysql');
	});

	describe('in windows', () => {
		const prefix = cutoverKeys.changes(ORG, OP);
		const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
		type World = Awaited<ReturnType<typeof ready>>;
		// one statement per write number, so a window shows which writes it carried
		const windows = (since: number, through: number) => [
			changeBody(
				Array.from(
					{ length: through - since },
					(_, at) => `REPLACE INTO \`node\` (\`nid\`) VALUES (${since + at + 1});`
				)
			)
		];
		const manifestOf = (world: World) =>
			JSON.parse(decode(world.store.objects.get(cutoverKeys.manifest(prefix))!));
		const progressOf = (world: World, read: 'first' | 'final' = 'first') =>
			JSON.parse(decode(world.store.objects.get(cutoverKeys.progress(prefix, read))!));
		const joined = (world: World) =>
			[...Array(manifestOf(world).parts).keys()]
				.map((seq) => decode(world.store.objects.get(partKey(prefix, seq, 'sql'))!))
				.join('');
		const whole = (...ranges: [number, number][]) =>
			ranges.map(([since, through]) => windows(since, through)[0]).join('');

		async function journal(writes: number, patch: Parameters<typeof ready>[0] = {}) {
			const world = await ready({
				windowWrites: 3,
				...patch,
				marks: { windows, ...patch.marks }
			});
			world.marks.state.writes = writes;
			return world;
		}

		// the nth body request streams one chunk and then stops the way a timeout does
		function stallAt(world: World, nth: number) {
			const read = world.marks.worker.body;
			let calls = 0;
			world.marks.worker.body = async (host, through, auth, since) => {
				const real = await read(host, through, auth, since);
				if (++calls !== nth) return real;
				const reader = real.stream.getReader();
				let sent = false;
				return {
					...real,
					stream: new ReadableStream<Uint8Array>({
						async pull(controller) {
							if (!sent) {
								sent = true;
								const chunk = await reader.read();
								if (!chunk.done) return controller.enqueue(chunk.value);
							}
							controller.error(new DOMException('timed out', 'TimeoutError'));
						}
					})
				};
			};
		}

		it('reads a list longer than one window as several parts, complete and in order', async () => {
			const world = await journal(7);
			const out = await world.destination.exportChanges(key('export-changes'), 'mysql');
			expect(out.through).toBe(7);
			expect(world.marks.state.asked).toEqual([
				[0, 3],
				[3, 6],
				[6, 7]
			]);
			expect(joined(world)).toBe(whole([0, 3], [3, 6], [6, 7]));
			expect(manifestOf(world)).toMatchObject({ parts: 3, statements: 7, through: 7 });
			expect(manifestOf(world).digest).toBe(
				await digestOfParts(
					await Promise.all(
						[0, 1, 2].map((seq) =>
							sha256Hex(world.store.objects.get(partKey(prefix, seq, 'sql'))!)
						)
					)
				)
			);
			expect(progressOf(world)).toMatchObject({ cursor: 7, target: 7 });
		});

		it('reads a window that times out again from its own cursor', async () => {
			const world = await journal(7);
			stallAt(world, 2);
			const failure = await failureOf(
				world.destination.exportChanges(key('export-changes'), 'mysql')
			);
			expect(failure).not.toBeInstanceOf(PermanentError);
			expect(progressOf(world)).toMatchObject({ cursor: 3, target: 7, statements: 3 });
			await world.destination.exportChanges(key('export-changes'), 'mysql');
			expect(world.marks.state.asked).toEqual([
				[0, 3],
				[3, 6],
				[3, 6],
				[6, 7]
			]);
			expect(joined(world)).toBe(whole([0, 3], [3, 6], [6, 7]));
		});

		it('gives the same file after a replay at every saved part', async () => {
			for (const stalled of [1, 2, 3]) {
				const world = await journal(7);
				stallAt(world, stalled);
				await failureOf(world.destination.exportChanges(key('export-changes'), 'mysql'));
				await world.destination.exportChanges(key('export-changes'), 'mysql');
				expect(joined(world)).toBe(whole([0, 3], [3, 6], [6, 7]));
				expect(manifestOf(world)).toMatchObject({ parts: 3, statements: 7 });
			}
		});

		it('keeps to the same list when more writes arrive before the replay', async () => {
			const world = await journal(7);
			stallAt(world, 2);
			await failureOf(world.destination.exportChanges(key('export-changes'), 'mysql'));
			world.marks.state.writes = 12;
			const out = await world.destination.exportChanges(key('export-changes'), 'mysql');
			expect(out.through).toBe(7);
			expect(out.cannotCarry.at(-1)).toBe(
				'5 changes the new site accepted after the file was saved'
			);
			expect(joined(world)).toBe(whole([0, 3], [3, 6], [6, 7]));
		});

		it('reads nothing again once every window is saved', async () => {
			const world = await journal(7);
			await world.destination.exportChanges(key('export-changes'), 'mysql');
			const once = joined(world);
			await world.destination.exportChanges(key('export-changes'), 'mysql');
			expect(world.marks.state.bodiesRead).toBe(3);
			expect(joined(world)).toBe(once);
		});

		it('starts over when a saved part is gone or changed', async () => {
			const world = await journal(7);
			stallAt(world, 3);
			await failureOf(world.destination.exportChanges(key('export-changes'), 'mysql'));
			world.store.objects.set(partKey(prefix, 0, 'sql'), new TextEncoder().encode('x'));
			await world.destination.exportChanges(key('export-changes'), 'mysql');
			expect(world.marks.state.asked.slice(-3)).toEqual([
				[0, 3],
				[3, 6],
				[6, 7]
			]);
			expect(joined(world)).toBe(whole([0, 3], [3, 6], [6, 7]));
		});

		it('saves one window for a journal that fits in it, and one for an empty journal', async () => {
			const small = await journal(2);
			await small.destination.exportChanges(key('export-changes'), 'mysql');
			expect(small.marks.state.asked).toEqual([[0, 2]]);
			const empty = await ready({ marks: { windows } });
			empty.marks.state.writes = 0;
			await empty.destination.exportChanges(key('export-changes'), 'mysql');
			expect(manifestOf(empty)).toMatchObject({ parts: 1, statements: 0, through: 0 });
		});

		it('reads a site that ignores since in one request from the start', async () => {
			const world = await journal(7, { marks: { ignoresSince: true } });
			await world.destination.exportChanges(key('export-changes'), 'mysql');
			expect(world.marks.state.asked).toEqual([
				[0, 3],
				[0, 7]
			]);
			expect(joined(world)).toBe(whole([0, 7]));
		});

		it('adds the last read in windows after the first file, and carries on after a stall', async () => {
			const world = await journal(4, { windowWrites: 2 });
			await world.destination.exportChanges(key('export-changes'), 'mysql');
			const first = joined(world);
			world.marks.state.writes = 9;
			world.marks.state.asked.length = 0;
			stallAt(world, 3);
			const failure = await failureOf(
				world.destination.exportFinalChanges(key('export-final'), 'mysql', 4)
			);
			expect(failure).not.toBeInstanceOf(PermanentError);
			expect(progressOf(world, 'final')).toMatchObject({ since: 4, cursor: 8, target: 9 });
			const out = await world.destination.exportFinalChanges(key('export-final'), 'mysql', 4);
			expect(out.statements).toBe(5);
			expect(world.marks.state.asked).toEqual([
				[4, 6],
				[6, 8],
				[8, 9],
				[8, 9]
			]);
			expect(joined(world)).toBe(first + whole([4, 6], [6, 8], [8, 9]));
			expect(manifestOf(world)).toMatchObject({
				statements: 9,
				through: 9,
				final: { since: 4, parts: 3, statements: 5 }
			});
		});

		it('refuses a final window from a site that ignores since', async () => {
			const world = await journal(4, { windowWrites: 2 });
			await world.destination.exportChanges(key('export-changes'), 'mysql');
			world.marks.state.writes = 9;
			const ignoring = world.marks.worker.body;
			world.marks.worker.body = async (host, through, auth, since) => ({
				...(await ignoring(host, through, auth, since)),
				since: -1
			});
			expect(
				await failureOf(
					world.destination.exportFinalChanges(key('export-final'), 'mysql', 4)
				)
			).toMatchObject({ code: 'export_since' });
		});
	});

	describe('the last read after the address moved back', () => {
		const LATE = ['REPLACE INTO `node` (`nid`) VALUES (4);'];
		const prefix = cutoverKeys.changes(ORG, OP);
		const manifestOf = (world: Awaited<ReturnType<typeof ready>>) =>
			JSON.parse(
				new TextDecoder().decode(world.store.objects.get(cutoverKeys.manifest(prefix))!)
			);
		const joined = (world: Awaited<ReturnType<typeof ready>>) =>
			[...Array(manifestOf(world).parts).keys()]
				.map((seq) =>
					new TextDecoder().decode(world.store.objects.get(partKey(prefix, seq, 'sql'))!)
				)
				.join('');

		async function afterFirst(patch: Parameters<typeof destinationWorld>[0] = {}) {
			const world = await ready({
				marks: { bodies: [[changeBody(ONE)], [changeBody(LATE, 1)]], ...patch?.marks },
				...patch
			});
			const first = await world.destination.exportChanges(key('export-changes'), 'mysql');
			expect(first.through).toBe(3);
			world.marks.state.writes = 5;
			return world;
		}

		it('adds the new parts after the first ones and keeps one manifest and one digest', async () => {
			const world = await afterFirst();
			const firstPart = world.store.objects.get(partKey(prefix, 0, 'sql'))!;
			const out = await world.destination.exportFinalChanges(key('export-final'), 'mysql', 3);
			expect(out.statements).toBe(1);
			expect(out.cannotCarry).toContain('Sign-in sessions');
			expect(world.store.objects.get(partKey(prefix, 0, 'sql'))).toEqual(firstPart);
			expect(joined(world)).toBe(changeBody(ONE) + changeBody(LATE, 1));
			const manifest = manifestOf(world);
			expect(manifest).toMatchObject({
				parts: 2,
				statements: 2,
				through: 5,
				final: { since: 3, parts: 1, statements: 1 }
			});
			expect(manifest.digest).toBe(
				await digestOfParts(
					await Promise.all(
						[0, 1].map((seq) =>
							sha256Hex(world.store.objects.get(partKey(prefix, seq, 'sql'))!)
						)
					)
				)
			);
			expect(world.marks.state.calls.at(-1)).toBe('body');
		});

		it('says so, and reads no body, when nothing was written after the first read', async () => {
			const world = await afterFirst();
			world.marks.state.writes = 3;
			const before = world.marks.state.bodiesRead;
			const out = await world.destination.exportFinalChanges(key('export-final'), 'mysql', 3);
			expect(out.statements).toBe(0);
			expect(world.marks.state.bodiesRead).toBe(before);
			expect(manifestOf(world)).toMatchObject({
				parts: 1,
				statements: 1,
				final: { since: 3, parts: 0, statements: 0 }
			});
			expect(joined(world)).toBe(changeBody(ONE));
		});

		it('gives the same file when run again and leaves the first read alone', async () => {
			const world = await afterFirst({
				marks: { bodies: [[changeBody(ONE)], [changeBody(LATE, 1)], [changeBody(LATE, 1)]] }
			});
			await world.destination.exportFinalChanges(key('export-final'), 'mysql', 3);
			const once = joined(world);
			await world.destination.exportFinalChanges(key('export-final'), 'mysql', 3);
			expect(joined(world)).toBe(once);
			expect(manifestOf(world)).toMatchObject({ parts: 2, statements: 2 });
		});

		it('treats a list cut short as a failure to retry and keeps the first read', async () => {
			const world = await afterFirst({
				marks: {
					bodies: [[changeBody(ONE)], [changeBody(LATE, null)], [changeBody(LATE, 1)]]
				}
			});
			const failure = await failureOf(
				world.destination.exportFinalChanges(key('export-final'), 'mysql', 3)
			);
			expect(failure).not.toBeInstanceOf(PermanentError);
			expect(failure.message).toBe(DESTINATION_REFUSALS.exportCutShort);
			expect(manifestOf(world)).toMatchObject({ parts: 1, statements: 1 });
			expect(manifestOf(world).final).toBeUndefined();
			await world.destination.exportFinalChanges(key('export-final'), 'mysql', 3);
			expect(manifestOf(world)).toMatchObject({ parts: 2, statements: 2 });
		});

		it('refuses a list from a site that ignores since, rather than save the whole list twice', async () => {
			const world = await afterFirst({
				marks: { ignoresSince: true, bodies: [[changeBody(ONE)], [changeBody(ONE)]] }
			});
			expect(
				await failureOf(
					world.destination.exportFinalChanges(key('export-final'), 'mysql', 3)
				)
			).toMatchObject({ code: 'export_since', message: DESTINATION_REFUSALS.exportSince });
			expect(manifestOf(world)).toMatchObject({ parts: 1, statements: 1 });
		});

		it('refuses with no first file, a lost count, and a database that is not MySQL', async () => {
			const bare = await ready();
			expect(
				await failureOf(
					bare.destination.exportFinalChanges(key('export-final'), 'mysql', 3)
				)
			).toMatchObject({ code: 'export_missing' });
			const world = await afterFirst();
			world.marks.state.mark = null;
			expect(
				await failureOf(
					world.destination.exportFinalChanges(key('export-final'), 'mysql', 3)
				)
			).toMatchObject({ code: 'write_count_lost' });
			expect(
				await failureOf(
					world.destination.exportFinalChanges(key('export-final'), 'pgsql', 3)
				)
			).toMatchObject({ code: 'export_dialect' });
		});

		it('finds a first part that went missing before it adds to the file', async () => {
			const world = await afterFirst();
			world.store.objects.delete(partKey(prefix, 0, 'sql'));
			expect(
				await failureOf(
					world.destination.exportFinalChanges(key('export-final'), 'mysql', 3)
				)
			).toMatchObject({ code: 'export_missing' });
		});
	});
});

// #endregion

// #endregion

describe('the owner routes that count writes', () => {
	const none = JSON.stringify({ ok: false, error: 'no mark is active' });
	const AUTH = { bearer: 'owner-token-value' };

	// answers by method and path; a path with no answer is a Drupal page
	function site(answers: Record<string, () => Response>) {
		const calls: { method: string; path: string; auth: string | null }[] = [];
		const fetcher = (async (input: URL | string, init?: RequestInit) => {
			const url = new URL(String(input));
			const method = init?.method ?? 'GET';
			const path = url.pathname + url.search;
			calls.push({
				method,
				path,
				auth: new Headers(init?.headers).get('authorization')
			});
			const answer = answers[`${method} ${path}`] ?? answers[`${method} ${url.pathname}`];
			return answer === undefined
				? new Response('<html>not found</html>', { status: 404 })
				: answer();
		}) as typeof fetch;
		return { worker: writeMarkWorkerOf(fetcher, 1000), calls };
	}
	const json = (status: number, body: unknown) => () => Response.json(body, { status });

	it('tells a site that has the routes from one that hands the request to Drupal', async () => {
		expect(
			await site({
				'GET /writemark': () => new Response(none, { status: 404 })
			}).worker.supported(NEW_ADDRESS, AUTH)
		).toBe(true);
		expect(await site({}).worker.supported(NEW_ADDRESS, AUTH)).toBe(false);
		expect(
			await site({ 'GET /writemark': json(501, {}) }).worker.supported(NEW_ADDRESS, AUTH)
		).toBe(false);
		expect(
			await site({
				'GET /writemark': json(200, { ok: true, mark: 'm', writes: 0, incomplete: false })
			}).worker.supported(NEW_ADDRESS, AUTH)
		).toBe(true);
	});

	it('sends the owner token and nothing else to the site named', async () => {
		const world = site({ 'GET /writemark': json(404, { ok: false, error: 'x' }) });
		await world.worker.read(NEW_ADDRESS, AUTH);
		expect(world.calls[0]).toMatchObject({ auth: 'Bearer owner-token-value' });
	});

	it('maps the start answers', async () => {
		const path = 'POST /writemark?mark=cutover-1';
		const start = (answer: () => Response) =>
			site({ [path]: answer }).worker.start(NEW_ADDRESS, 'cutover-1', AUTH);
		expect(await start(json(201, { ok: true, status: 'started' }))).toBe('started');
		expect(await start(json(200, { ok: true, status: 'existing' }))).toBe('existing');
		expect(await start(json(409, { ok: false, error: 'x', active: { mark: 'o' } }))).toBe(
			'taken'
		);
		expect(await site({}).worker.start(NEW_ADDRESS, 'cutover-1', AUTH)).toBe('missing');
		// a replica lane refuses without naming a mark, and a failure is not an answer either
		expect(
			await failureOf(start(json(409, { ok: false, error: 'a replica' })))
		).not.toBeInstanceOf(PermanentError);
		expect(await failureOf(start(json(503, {})))).not.toBeInstanceOf(PermanentError);
	});

	it('maps the count answers and never reads a refusal as zero', async () => {
		const read = (answer: () => Response) =>
			site({ 'GET /writemark': answer }).worker.read(NEW_ADDRESS, AUTH);
		expect(
			await read(
				json(200, {
					ok: true,
					mark: 'm',
					writes: 7,
					incomplete: true,
					reason: 'journal_full'
				})
			)
		).toEqual({ mark: 'm', writes: 7, incomplete: 'journal_full' });
		expect(
			await read(json(200, { ok: true, mark: 'm', writes: 0, incomplete: false }))
		).toEqual({ mark: 'm', writes: 0, incomplete: null });
		expect(await read(() => new Response(none, { status: 404 }))).toBe('none');
		expect(await site({}).worker.read(NEW_ADDRESS, AUTH)).toBe('missing');
		expect(await failureOf(read(json(503, {})))).not.toBeInstanceOf(PermanentError);
		expect(
			await failureOf(read(json(409, { ok: false, error: 'a replica' })))
		).not.toBeInstanceOf(PermanentError);
		expect(await failureOf(read(json(200, { ok: true })))).not.toBeInstanceOf(PermanentError);
		expect(await failureOf(read(json(401, {})))).toMatchObject({
			code: 'owner_token_rejected'
		});
	});

	it('ends a count and ignores a mark that is not ours', async () => {
		const path = 'DELETE /writemark?mark=cutover-1';
		for (const status of [200, 409, 404]) {
			await site({ [path]: json(status, { ok: true }) }).worker.end(
				NEW_ADDRESS,
				'cutover-1',
				AUTH
			);
		}
		expect(
			await failureOf(
				site({ [path]: json(503, {}) }).worker.end(NEW_ADDRESS, 'cutover-1', AUTH)
			)
		).not.toBeInstanceOf(PermanentError);
	});

	it('reads the manifest and asks for a point when given one', async () => {
		const manifest = {
			ok: true,
			dialect: 'mysql',
			mark: 'm',
			through: 4,
			writes: 6,
			cap: 10,
			incomplete: false,
			cannotCarry: ['sessions']
		};
		const world = site({ 'GET /writechanges?dialect=mysql&through=4': json(200, manifest) });
		expect(await world.worker.manifest(NEW_ADDRESS, AUTH, 4)).toEqual({
			mark: 'm',
			writes: 6,
			incomplete: null,
			through: 4,
			cannotCarry: ['sessions']
		});
		expect(await site({}).worker.manifest(NEW_ADDRESS, AUTH)).toBe('missing');
	});

	it('streams the body with the point and the incomplete flag from its headers', async () => {
		const world = site({
			'GET /writechanges?body=1&through=4&dialect=mysql': () =>
				new Response('-- end, 0 statements\n', {
					headers: { 'x-cfw-through': '4', 'x-cfw-incomplete': 'journal_full' }
				})
		});
		const body = await world.worker.body(NEW_ADDRESS, 4, AUTH);
		expect(body).toMatchObject({ through: 4, incomplete: 'journal_full' });
		expect(await new Response(body.stream).text()).toBe('-- end, 0 statements\n');
		const gone = site({});
		expect(await failureOf(gone.worker.body(NEW_ADDRESS, 4, AUTH))).toMatchObject({
			code: 'write_count_lost'
		});
	});

	it('asks for the writes after a point and reports where the site says the list starts', async () => {
		const world = site({
			'GET /writechanges?body=1&through=9&dialect=mysql&since=4': () =>
				new Response('-- end, 0 statements\n', {
					headers: { 'x-cfw-through': '9', 'x-cfw-since': '4' }
				})
		});
		expect(await world.worker.body(NEW_ADDRESS, 9, AUTH, 4)).toMatchObject({
			through: 9,
			since: 4
		});
		const old = site({
			'GET /writechanges?body=1&through=9&dialect=mysql&since=4': () =>
				new Response('-- end, 0 statements\n', { headers: { 'x-cfw-through': '9' } })
		});
		expect(await old.worker.body(NEW_ADDRESS, 9, AUTH, 4)).toMatchObject({ since: -1 });
	});
});

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
			marks: fakeMarks().worker,
			site: { probe: async () => ({ status: 200 }) },
			sleep: async () => {}
		});
		await ports.source(REF, ORG).snapshot(key('snapshot'));
		expect(world.opened[0]?.orgId).toBe(ORG);
		await expect(ports.destination(SITE).acceptedWrites(key('write-mark'))).rejects.toThrow();
	});
});
