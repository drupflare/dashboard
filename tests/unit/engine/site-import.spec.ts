import { describe, expect, it } from 'vitest';
import { importKeys } from '../../../engine/src/import-parts';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import {
	planSiteImport,
	runSiteImport,
	type SiteImportInput
} from '../../../engine/src/workflows/site-import';
import { MARKER } from './backup-fakes';
import { Killed, makeRunner, makeWorld, type Memo, type RunnerScript } from './fakes';
import {
	credentialRows,
	DAY_MS,
	fakeSource,
	importDepsOf,
	KEY_MARKER,
	ROOT,
	sealCredential,
	SOURCE_HOST,
	tarOf,
	type FakeSource
} from './import-fakes';

interface Options {
	source?: Partial<FakeSource>;
	fingerprint?: string | null;
	expiresAt?: number;
}

async function importWorld(options: Options = {}) {
	const world = await makeWorld();
	const now = world.clock.now();
	// the hidden row the request writes, which the engine activates last
	world.sqlite
		.prepare(
			`INSERT INTO sites (id, organization_id, name, plane, state, primary_hostname, created_at,
			updated_at) VALUES (?, ?, 'Old Site', 'managed', 'active', ?, ?, ?)`
		)
		.run(world.siteId, world.orgId, world.input.hostname, now, now);
	const credentialId = await sealCredential(world, {
		orgId: world.orgId,
		now,
		...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
		...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt })
	});
	const source = fakeSource(options.source);
	const built = importDepsOf(world, { connector: source.connector });
	built.worker.add(world.input.hostname, world.siteId, { sql: '' });
	return { world, credentialId, source, ...built };
}

type Iw = Awaited<ReturnType<typeof importWorld>>;

function inputOf(iw: Iw, patch: Partial<SiteImportInput> = {}): SiteImportInput {
	const { input } = iw.world;
	return {
		operationId: iw.world.operationId,
		orgId: iw.world.orgId,
		credentialId: iw.credentialId,
		root: ROOT,
		dossier: { importable: true, estimateBytes: iw.source.source.dump.length, fileCount: 0 },
		create: {
			...input,
			firstRun: { ...input.firstRun!, reads: { ownerToken: 'ownerToken' } }
		},
		waitMs: 60_000,
		pollMs: 1_000,
		partBytes: 300,
		...patch
	};
}

async function run(
	iw: Iw,
	options: { memo?: Memo; script?: RunnerScript; patch?: Partial<SiteImportInput> } = {}
) {
	const input = inputOf(iw, options.patch);
	if (options.memo === undefined || options.memo.size === 0) {
		const frozen = await freezePlan(planSiteImport(input));
		await iw.world.store.begin({
			operation: newOperation({
				id: input.operationId,
				orgId: input.orgId,
				idempotencyKey: 'import-1',
				frozen,
				now: iw.world.clock.now()
			}),
			accountId: iw.world.accountId,
			siteId: iw.world.siteId
		});
	}
	const memo = options.memo ?? new Map();
	const { runner, executed } = makeRunner(memo, options.script);
	return { outcome: await runSiteImport(runner, iw.deps, input), executed, memo };
}

const targetRow = (iw: Iw) =>
	iw.world.sqlite
		.prepare('SELECT state, ready_at, imported_from, account_id FROM sites WHERE id = ?')
		.get(iw.world.siteId);

const operationOf = async (iw: Iw) => (await iw.world.store.get(iw.world.operationId))!;

const codeOf = (reason: string) => /^[\w.-]+: ([a-z_]+): /.exec(reason)?.[1];

const bucketKeys = (iw: Iw) =>
	[...iw.blobs.objects.keys()].filter((key) =>
		key.startsWith(importKeys.prefix(iw.world.orgId, iw.world.operationId))
	);

const everything = (iw: Iw, memo: Memo, outcome: unknown) =>
	JSON.stringify({
		memo: [...memo.entries()],
		outcome,
		operations: iw.world.sqlite.prepare('SELECT * FROM operations').all(),
		steps: iw.world.sqlite.prepare('SELECT * FROM operation_steps').all(),
		sites: iw.world.sqlite.prepare('SELECT * FROM sites').all(),
		log: iw.log
	});

describe('the plan', () => {
	it('names the new site and the key, with unique step ids in a fixed order', async () => {
		const iw = await importWorld();
		const plan = planSiteImport(inputOf(iw));
		expect(plan.type).toBe('site.import');
		expect(plan.targetIds).toEqual([iw.world.siteId, iw.credentialId]);
		const ids = plan.steps.map((step) => step.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.slice(0, 3)).toEqual(['lease', 'preflight', 'dump']);
		expect(ids.slice(-3)).toEqual(['verify', 'activate', 'forget']);
		expect(ids.indexOf('convert')).toBeLessThan(ids.indexOf('reserve-name'));
		expect(ids.indexOf('link')).toBeLessThan(ids.indexOf('restore'));
		expect(ids).not.toContain('files-archive');
	});

	it('adds the files steps when the survey counted files', async () => {
		const iw = await importWorld();
		const plan = planSiteImport(
			inputOf(iw, { dossier: { importable: true, estimateBytes: 1, fileCount: 3 } })
		);
		const ids = plan.steps.map((step) => step.id);
		expect(ids).toContain('files-archive');
		expect(ids).not.toContain('files');
		expect(ids.indexOf('convert')).toBeLessThan(ids.indexOf('files-convert'));
		expect(ids.indexOf('files-convert')).toBeLessThan(ids.indexOf('reserve-name'));
	});
});

describe('a successful import', () => {
	it('lands the converted database in a new live site and deletes the key and the copies', async () => {
		const iw = await importWorld();
		const { outcome } = await run(iw);
		expect(outcome).toEqual({ status: 'succeeded' });

		const landed = iw.worker.sites.get(iw.world.input.hostname)!.sql;
		expect(landed).toContain(MARKER);
		expect(landed).not.toContain('ENGINE=InnoDB');
		expect(targetRow(iw)).toMatchObject({
			state: 'active',
			imported_from: SOURCE_HOST,
			account_id: iw.world.accountId
		});
		expect(targetRow(iw)!.ready_at).not.toBeNull();
		expect(credentialRows(iw.world)).toEqual([]);
		expect(bucketKeys(iw)).toEqual([]);
		const operation = await operationOf(iw);
		expect(operation.status).toBe('succeeded');
		expect(operation.verification).toBe('passed');
		expect(operation.steps.every((step) => step.state === 'succeeded')).toBe(true);
		expect(iw.world.leases.stateOf(iw.world.siteId).holder ?? null).toBeNull();
	});

	it('sends the server one read-only dump command and nothing else', async () => {
		const iw = await importWorld();
		await run(iw);
		expect(iw.source.sessions).toHaveLength(1);
		expect(iw.source.sessions[0]!.commands).toEqual([
			`cd '${ROOT}' && drush sql:dump --extra-dump=--hex-blob`
		]);
		expect(iw.source.sessions[0]!.closed).toBe(true);
	});

	it('keeps the key out of every record, memo, log and outcome', async () => {
		const iw = await importWorld();
		const { outcome, memo } = await run(iw);
		expect(everything(iw, memo, outcome)).not.toContain(KEY_MARKER);
		expect(everything(iw, memo, outcome)).not.toContain('PRIVATE KEY');
	});

	it('picks up after a killed run and dumps the server once', async () => {
		const iw = await importWorld();
		const memo: Memo = new Map();
		await run(iw, { memo, script: { killAfter: 9 } }).catch((error) => {
			expect(error).toBeInstanceOf(Killed);
		});
		const first = [...memo.keys()];
		expect(first.length).toBeGreaterThan(0);
		const { runner, executed } = makeRunner(memo);
		expect(await runSiteImport(runner, iw.deps, inputOf(iw))).toEqual({ status: 'succeeded' });
		expect(executed.some((name) => first.includes(name))).toBe(false);
		expect(iw.source.sessions).toHaveLength(1);
	});
});

describe('a refusal before the server is touched', () => {
	async function refused(iw: Iw, patch?: Partial<SiteImportInput>) {
		const { outcome } = await run(iw, { patch });
		expect(outcome.status).toBe('rolled-back');
		expect(iw.source.sessions).toEqual([]);
		expect(credentialRows(iw.world)).toEqual([]);
		expect(targetRow(iw)!.state).toBe('deleted');
		return outcome.status === 'rolled-back' ? codeOf(outcome.reason) : undefined;
	}

	it('refuses a key whose host key was never confirmed', async () => {
		const iw = await importWorld({ fingerprint: null });
		expect(await refused(iw)).toBe('host_key_unconfirmed');
	});

	it('refuses a key past its 24 hours', async () => {
		const iw = await importWorld();
		iw.world.clock.advance(DAY_MS + 1);
		expect(await refused(iw)).toBe('credential_expired');
	});

	it('refuses a key that is gone', async () => {
		const iw = await importWorld();
		iw.world.sqlite.prepare('DELETE FROM import_credentials').run();
		expect(await refused(iw)).toBe('credential_missing');
	});

	it('refuses a key of another organization', async () => {
		const iw = await importWorld();
		expect(await refused(iw, { orgId: `org_${'q'.repeat(26)}` })).toBe('credential_missing');
	});

	it('refuses a dossier that is not importable', async () => {
		const iw = await importWorld();
		const code = await refused(iw, {
			dossier: { importable: false, estimateBytes: null, fileCount: null }
		});
		expect(code).toBe('dossier_refused');
	});

	it('refuses a kind whose first run gives no owner token', async () => {
		const iw = await importWorld();
		const input = inputOf(iw);
		const code = await refused(iw, {
			create: { ...input.create, firstRun: { ...input.create.firstRun, reads: {} } }
		});
		expect(code).toBe('unsupported_kind');
	});

	it('refuses a host key that is not the confirmed one before any command runs', async () => {
		const iw = await importWorld({
			source: { serverKey: new TextEncoder().encode('swapped') }
		});
		const { outcome } = await run(iw);
		expect(outcome.status).toBe('rolled-back');
		expect(outcome.status === 'rolled-back' ? codeOf(outcome.reason) : null).toBe(
			'host_key_mismatch'
		);
		expect(iw.source.sessions).toHaveLength(1);
		expect(iw.source.sessions[0]!.commands).toEqual([]);
		expect(credentialRows(iw.world)).toEqual([]);
		expect(targetRow(iw)!.state).toBe('deleted');
	});
});

describe('the size ceiling', () => {
	it('stops the stream above twice the ceiling and says which limit it hit', async () => {
		const iw = await importWorld();
		const { outcome, executed } = await run(iw, { patch: { restoreCeilingBytes: 300 } });
		expect(outcome.status).toBe('rolled-back');
		expect(outcome.status === 'rolled-back' ? codeOf(outcome.reason) : null).toBe(
			'restore_too_large'
		);
		const step = (await operationOf(iw)).steps.find((entry) => entry.state === 'failed');
		expect(step?.id).toBe('dump');
		expect(executed).not.toContain('target.reserve-name');
		expect(iw.world.names.calls).toEqual([`release:${iw.world.input.subdomain}`]);
		expect(credentialRows(iw.world)).toEqual([]);
		expect(bucketKeys(iw)).toEqual([]);
	});

	it('accepts a database that fits the ceiling', async () => {
		const iw = await importWorld();
		const { outcome } = await run(iw, { patch: { restoreCeilingBytes: 16 * 1024 * 1024 } });
		expect(outcome).toEqual({ status: 'succeeded' });
	});
});

describe('the files archive', () => {
	const WITH_FILES = { importable: true, estimateBytes: 1, fileCount: 2 };
	const archive = () =>
		tarOf([
			{ name: './', type: 'directory' },
			{ name: './logo.png', body: new Uint8Array([0, 1, 2, 3, 0, 255]) },
			{ name: "./docs/it's.txt", body: 'FILEDATA-91' }
		]);

	it('lands the files rows in the one restore that carries the database', async () => {
		const iw = await importWorld({ source: { files: archive() } });
		const { outcome } = await run(iw, { patch: { dossier: WITH_FILES } });
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(iw.worker.calls.restores).toHaveLength(1);
		const body = iw.worker.calls.restores[0]!.body;
		expect(body).toContain(MARKER);
		expect(body).toContain("'public://docs/it''s.txt'");
		expect(body).toContain("'public://logo.png'");
		expect(body).toContain("x'0001020300ff'");
		const operation = await operationOf(iw);
		expect(operation.steps.find((step) => step.id === 'files-convert')?.state).toBe(
			'succeeded'
		);
		expect(operation.steps.every((step) => step.state === 'succeeded')).toBe(true);
		const commands = iw.source.sessions.flatMap((session) => session.commands);
		expect(commands.filter((command) => command.startsWith('tar '))).toHaveLength(1);
		expect(credentialRows(iw.world)).toEqual([]);
		expect(bucketKeys(iw)).toEqual([]);
	});

	it('says how many links it left behind', async () => {
		const iw = await importWorld({
			source: {
				files: tarOf([
					{ name: './a.txt', body: 'a' },
					{ name: './link', type: 'symlink' }
				])
			}
		});
		const { outcome } = await run(iw, { patch: { dossier: WITH_FILES } });
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(JSON.stringify(await operationOf(iw))).toContain('1 links in the files folder');
		expect(iw.worker.calls.restores[0]!.body).not.toContain('link');
	});

	it('counts the files and the database together and refuses before anything is made', async () => {
		const probe = await importWorld();
		await run(probe);
		const database = probe.worker.calls.restores[0]!.body.length;
		const files = tarOf([{ name: './big.bin', body: new Uint8Array(600) }]);
		const iw = await importWorld({ source: { files } });
		const { outcome, executed } = await run(iw, {
			patch: { dossier: WITH_FILES, restoreCeilingBytes: database + 400 }
		});
		expect(outcome.status).toBe('rolled-back');
		expect(outcome.status === 'rolled-back' ? codeOf(outcome.reason) : null).toBe(
			'restore_too_large'
		);
		expect((await operationOf(iw)).steps.find((step) => step.state === 'failed')?.id).toBe(
			'files-convert'
		);
		expect(executed).not.toContain('target.reserve-name');
		expect(iw.worker.calls.restores).toEqual([]);
		expect(credentialRows(iw.world)).toEqual([]);
		expect(bucketKeys(iw)).toEqual([]);
	});

	it('accepts the same files when the ceiling has room for both', async () => {
		const probe = await importWorld();
		await run(probe);
		const database = probe.worker.calls.restores[0]!.body.length;
		const iw = await importWorld({
			source: { files: tarOf([{ name: './small.bin', body: new Uint8Array(20) }]) }
		});
		const { outcome } = await run(iw, {
			patch: { dossier: WITH_FILES, restoreCeilingBytes: database + 4000 }
		});
		expect(outcome).toEqual({ status: 'succeeded' });
	});

	it.each([
		['a path that climbs out', tarOf([{ name: '../x', body: 'x' }]), 'files_bad_path'],
		['an archive that was cut short', archive().slice(0, 700), 'files_unreadable'],
		['bytes that are not a tar', new Uint8Array(40).fill(7), 'files_unreadable']
	])('rolls back on %s with a plain code', async (_name, files, code) => {
		const iw = await importWorld({ source: { files } });
		const { outcome } = await run(iw, { patch: { dossier: WITH_FILES } });
		expect(outcome.status).toBe('rolled-back');
		expect(outcome.status === 'rolled-back' ? codeOf(outcome.reason) : null).toBe(code);
		expect(iw.worker.calls.restores).toEqual([]);
		expect(targetRow(iw)!.state).toBe('deleted');
		expect(credentialRows(iw.world)).toEqual([]);
		expect(bucketKeys(iw)).toEqual([]);
	});

	it('stops the files stream above what the ceiling could ever hold', async () => {
		const iw = await importWorld({
			source: { files: new Uint8Array(24_000_000), chunk: 1_000_000 }
		});
		const { outcome } = await run(iw, {
			patch: {
				dossier: WITH_FILES,
				restoreCeilingBytes: 16 * 1024 * 1024,
				partBytes: 2_000_000
			}
		});
		expect(outcome.status).toBe('rolled-back');
		expect(outcome.status === 'rolled-back' ? codeOf(outcome.reason) : null).toBe(
			'files_too_large'
		);
	});

	it('converts again after a kill with the same rows and one stream from the server', async () => {
		const dry = await importWorld({ source: { files: archive() } });
		const first = await run(dry, { patch: { dossier: WITH_FILES } });
		const at = first.executed.indexOf('files-convert') + 1;
		expect(at).toBeGreaterThan(0);

		const iw = await importWorld({ source: { files: archive() } });
		const memo: Memo = new Map();
		await run(iw, { memo, script: { killDuring: at }, patch: { dossier: WITH_FILES } }).catch(
			(error) => expect(error).toBeInstanceOf(Killed)
		);
		expect(memo.has('files-convert')).toBe(false);
		const { runner } = makeRunner(memo);
		const input = inputOf(iw, { dossier: WITH_FILES });
		expect(await runSiteImport(runner, iw.deps, input)).toEqual({ status: 'succeeded' });
		expect(iw.worker.calls.restores).toHaveLength(1);
		const body = iw.worker.calls.restores[0]!.body;
		expect(body.split('INSERT OR REPLACE INTO "cfw_file" ').length - 1).toBe(2);
		expect(iw.source.sessions.flatMap((session) => session.commands)).toHaveLength(2);
	});
});

const FAIL_AT = [
	'preflight',
	'dump',
	'convert.0',
	'target.reserve-name',
	'target.route',
	'target.first-run',
	'link',
	'restore',
	'apply',
	'verify'
];

describe('a failure at each step', () => {
	it.each(FAIL_AT)('rolls back and deletes the key and the copies after %s', async (step) => {
		const iw = await importWorld();
		const account = iw.world.cf.snapshot();
		const { outcome, executed, memo } = await run(iw, {
			script: { failAt: { step, when: 'before' } }
		});
		expect(executed).toContain(step);
		expect(outcome.status).toBe('rolled-back');
		expect(credentialRows(iw.world)).toEqual([]);
		expect(bucketKeys(iw)).toEqual([]);
		expect(targetRow(iw)).toMatchObject({ state: 'deleted' });
		expect({ ...iw.world.cf.snapshot(), assets: [] }).toEqual({ ...account, assets: [] });
		expect((await operationOf(iw)).status).toBe('rolled-back');
		expect(iw.world.leases.stateOf(iw.world.siteId).holder ?? null).toBeNull();
		expect(everything(iw, memo, outcome)).not.toContain(KEY_MARKER);
		// the source only ever saw reads
		for (const session of iw.source.sessions) {
			for (const command of session.commands) expect(command).toMatch(/drush sql:dump|^tar /);
		}
	});

	it('leaves a site that went live as it is, and still deletes the key', async () => {
		const iw = await importWorld();
		const { outcome } = await run(iw, {
			script: { failAt: { step: 'target.activate', when: 'after' } }
		});
		expect(outcome).toMatchObject({ status: 'failed', leaked: [] });
		expect(targetRow(iw)!.ready_at).not.toBeNull();
		expect(credentialRows(iw.world)).toEqual([]);
		expect(bucketKeys(iw)).toEqual([]);
	});

	it('reports a failed delete of the key as leaked', async () => {
		const iw = await importWorld();
		const original = iw.deps.imports.discard;
		iw.deps.imports.discard = async () => {
			throw new Error('d1 is down');
		};
		const { outcome } = await run(iw, {
			script: { failAt: { step: 'link', when: 'before' } }
		});
		expect(outcome).toMatchObject({ status: 'failed' });
		expect(outcome.status === 'failed' ? outcome.leaked : []).toContain('credential');
		iw.deps.imports.discard = original;
	});
});

describe('the dump of a failed run', () => {
	it('keeps no part of a stream that dropped', async () => {
		const iw = await importWorld({ source: { dropAfter: 2 } });
		const { outcome } = await run(iw);
		expect(outcome.status).toBe('rolled-back');
		expect(bucketKeys(iw)).toEqual([]);
		expect(credentialRows(iw.world)).toEqual([]);
	});

	it('fails a dump whose command exits nonzero', async () => {
		const iw = await importWorld({ source: { exitCode: 1 } });
		const { outcome } = await run(iw);
		expect(outcome.status === 'rolled-back' ? codeOf(outcome.reason) : null).toBe(
			'dump_failed'
		);
	});

	it('fails an empty dump', async () => {
		const iw = await importWorld({ source: { dump: '' } });
		const { outcome } = await run(iw);
		expect(outcome.status === 'rolled-back' ? codeOf(outcome.reason) : null).toBe('dump_empty');
	});
});
