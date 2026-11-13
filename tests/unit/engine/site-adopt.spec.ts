import type { D1Database } from '@cloudflare/workers-types';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1BackupLedger } from '../../../engine/src/adapters/backups';
import { backupWorkerOf } from '../../../engine/src/adapters/site';
import { TABLES } from '../../../engine/src/files-convert';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { BackupDeps } from '../../../engine/src/ports';
import { FILE_BATCH_FILES, MAX_COPIED_FILES } from '../../../engine/src/workflows/offloaded-files';
import {
	planSiteAdopt,
	runSiteAdopt,
	type SiteAdoptInput
} from '../../../engine/src/workflows/site-adopt';
import { MAX_RESTORE_PAGED_BYTES } from '../../../src/shared/restore-limits';
import {
	dumpOf,
	fakeBlobs,
	fakeKv,
	fakeWorkers,
	MARKER,
	splitLikeTheWorker,
	type FakeFile
} from './backup-fakes';
import {
	FAKE_OWNER_TOKEN,
	Killed,
	makeRunner,
	makeWorld,
	type Memo,
	type RunnerScript
} from './fakes';

const SRC = `site_${'a'.repeat(26)}`;
const SRC_HOST = 'source.example.test';
const SRC_ACCOUNT = 'c'.repeat(32);
const BACKUP_ID = `bkp_${'b'.repeat(26)}`;

interface Options {
	dumpRows?: number;
	sourcePlane?: string;
	token?: boolean;
	adoptedTo?: string | null;
	probe?: number;
	offloaded?: number;
	files?: FakeFile[];
	dump?: string;
	target?: Parameters<ReturnType<typeof fakeWorkers>['add']>[2];
}

async function adoptWorld(options: Options = {}) {
	const world = await makeWorld();
	const log: string[] = [];
	const db = (world.ledger as unknown as { db: D1Database }).db;
	const worker = fakeWorkers(log);
	const blobs = fakeBlobs();
	const kv = fakeKv(log);
	const now = world.clock.now();
	await world.store.activateSite(
		{
			id: SRC,
			organizationId: world.orgId,
			name: 'Old Site',
			plane: options.sourcePlane ?? 'self-managed',
			accountId: SRC_ACCOUNT,
			category: 'cms',
			config: 'canonical'
		},
		now
	);
	world.sqlite
		.prepare('UPDATE sites SET primary_hostname = ?, adopted_to = ? WHERE id = ?')
		.run(SRC_HOST, options.adoptedTo ?? null, SRC);
	// the hidden row the request writes, which the engine activates last
	world.sqlite
		.prepare(
			`INSERT INTO sites (id, organization_id, name, plane, state, primary_hostname, created_at,
			updated_at) VALUES (?, ?, 'Old Site', 'managed', 'active', ?, ?, ?)`
		)
		.run(world.siteId, world.orgId, world.input.hostname, now, now);
	if (options.token !== false) await world.deps.custody.sealOwnerToken(SRC, FAKE_OWNER_TOKEN);
	const dump = options.dump ?? dumpOf(options.dumpRows ?? 40);
	worker.add(SRC_HOST, SRC, {
		sql: dump,
		aligned: true,
		offloaded: options.offloaded ?? options.files?.length ?? 0,
		files: options.files ?? null
	});
	worker.add(world.input.hostname, world.siteId, { sql: '', ...options.target });
	if (options.probe !== undefined) world.site.answers.probe = options.probe;
	const deps: BackupDeps = {
		...world.deps,
		worker: backupWorkerOf(worker.fetcher, 1_000),
		blobs: blobs.blobs,
		backups: new D1BackupLedger(db),
		kv: kv.kv,
		sleep: async (ms) => {
			world.clock.advance(ms);
			worker.alarm();
		}
	};
	return { world, deps, worker, blobs, dump, log };
}

type Aw = Awaited<ReturnType<typeof adoptWorld>>;

function inputOf(aw: Aw, patch: Partial<SiteAdoptInput> = {}): SiteAdoptInput {
	const { input } = aw.world;
	return {
		operationId: aw.world.operationId,
		orgId: aw.world.orgId,
		backupId: BACKUP_ID,
		source: { id: SRC, accountId: SRC_ACCOUNT },
		create: {
			...input,
			firstRun: { ...input.firstRun!, reads: { ownerToken: 'ownerToken' } }
		},
		waitMs: 60_000,
		pollMs: 1_000,
		...patch
	};
}

async function run(
	aw: Aw,
	options: { memo?: Memo; script?: RunnerScript; patch?: Partial<SiteAdoptInput> } = {}
) {
	const input = inputOf(aw, options.patch);
	if (options.memo === undefined || options.memo.size === 0) {
		const frozen = await freezePlan(planSiteAdopt(input));
		const operation = newOperation({
			id: input.operationId,
			orgId: input.orgId,
			idempotencyKey: 'adopt-1',
			frozen,
			now: aw.world.clock.now()
		});
		await aw.world.store.begin({
			operation,
			accountId: aw.world.accountId,
			siteId: SRC
		});
	}
	const { runner, executed } = makeRunner(options.memo ?? new Map(), options.script);
	return { outcome: await runSiteAdopt(runner, aw.deps, input), executed };
}

const sourceRow = (aw: Aw) =>
	aw.world.sqlite
		.prepare(
			'SELECT name, plane, state, primary_hostname, account_id, ready_at, adopted_to FROM sites WHERE id = ?'
		)
		.get(SRC);

const targetRow = (aw: Aw) =>
	aw.world.sqlite
		.prepare('SELECT state, ready_at, adopted_from, account_id FROM sites WHERE id = ?')
		.get(aw.world.siteId);

function codeOf(reason: string): string | undefined {
	return /^[\w.]+: ([a-z_]+): /.exec(reason)?.[1];
}

async function operationOf(aw: Aw) {
	return (await aw.world.store.get(aw.world.operationId))!;
}

const MIB = 1024 * 1024;
const bytesOf = (text: string) => new TextEncoder().encode(text);
const file = (uri: string, text: string, extra: Partial<FakeFile> = {}): FakeFile => ({
	uri,
	bytes: bytesOf(text),
	...extra
});

describe('the plan', () => {
	it('names the new site first and the source second, with unique step ids', async () => {
		const aw = await adoptWorld();
		const plan = planSiteAdopt(inputOf(aw));
		expect(plan.type).toBe('site.adopt');
		expect(plan.targetIds).toEqual([aw.world.siteId, SRC]);
		const ids = plan.steps.map((step) => step.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.slice(0, 2)).toEqual(['lease', 'preflight']);
		expect(ids.slice(-3)).toEqual(['files', 'verify', 'activate']);
		expect(ids.indexOf('link')).toBeLessThan(ids.indexOf('restore'));
	});
});

describe('a successful adoption', () => {
	it('restores the source database into a new live site and marks the source', async () => {
		const aw = await adoptWorld();
		const { outcome } = await run(aw);
		expect(outcome).toEqual({ status: 'succeeded' });

		expect(aw.worker.sites.get(world(aw).input.hostname)!.sql).toBe(aw.dump);
		expect(aw.dump).toContain(MARKER);
		expect(targetRow(aw)).toMatchObject({
			state: 'active',
			adopted_from: SRC,
			account_id: aw.world.accountId
		});
		expect(targetRow(aw)!.ready_at).not.toBeNull();
		expect(sourceRow(aw)).toMatchObject({
			plane: 'self-managed',
			state: 'active',
			primary_hostname: SRC_HOST,
			account_id: SRC_ACCOUNT,
			adopted_to: aw.world.siteId
		});
		const operation = await operationOf(aw);
		expect(operation.status).toBe('succeeded');
		expect(operation.verification).toBe('passed');
		expect(operation.steps.every((step) => step.state === 'succeeded')).toBe(true);
		const backup = await aw.deps.backups.get(aw.world.orgId, BACKUP_ID);
		expect(backup).toMatchObject({ siteId: SRC, label: 'Copy made to adopt the site' });
		expect(aw.world.leases.stateOf(SRC).holder ?? null).toBeNull();
	});

	it('never sends the source anything but export reads', async () => {
		const aw = await adoptWorld();
		await run(aw);
		expect(aw.worker.calls.restores.map((call) => call.host)).toEqual([
			world(aw).input.hostname
		]);
		expect(aw.worker.sites.get(SRC_HOST)!.sql).toBe(aw.dump);
		expect(aw.worker.sites.get(SRC_HOST)!.imports).toEqual([]);
	});

	it('keeps no admin password for the new site', async () => {
		const aw = await adoptWorld();
		await run(aw);
		const pending = aw.world.sqlite.prepare('SELECT site_id FROM pending_secrets').all();
		expect(pending).toEqual([]);
		expect(aw.world.sqlite.prepare('SELECT site_id FROM owner_tokens').all()).toHaveLength(2);
	});

	it('picks up after a killed run and sends the dump once', async () => {
		const aw = await adoptWorld();
		const memo: Memo = new Map();
		let first: string[] = [];
		const input = inputOf(aw);
		await run(aw, { memo, script: { killAfter: 14 } }).catch((error) => {
			expect(error).toBeInstanceOf(Killed);
		});
		first = [...memo.keys()];
		expect(first.length).toBeGreaterThan(0);
		const frozen = memo.size;
		expect(frozen).toBeGreaterThan(0);
		const { runner, executed } = makeRunner(memo);
		expect(await runSiteAdopt(runner, aw.deps, input)).toEqual({ status: 'succeeded' });
		expect(executed.some((name) => first.includes(name))).toBe(false);
		expect(aw.worker.calls.restores).toHaveLength(1);
	});
});

const world = (aw: Aw) => aw.world;

describe('a refusal before anything is created', () => {
	async function refused(aw: Aw, patch?: Partial<SiteAdoptInput>) {
		const before = sourceRow(aw);
		const account = aw.world.cf.snapshot();
		const { outcome } = await run(aw, { patch });
		expect(outcome.status).toBe('rolled-back');
		expect(aw.world.names.calls).toEqual([`release:${aw.world.input.subdomain}`]);
		expect(aw.world.cf.snapshot()).toEqual(account);
		expect(sourceRow(aw)).toEqual(before);
		expect(targetRow(aw)!.state).toBe('deleted');
		expect(aw.worker.calls.restores).toEqual([]);
		return outcome.status === 'rolled-back' ? codeOf(outcome.reason) : undefined;
	}

	it('stops a database above the restore ceiling and names the limit', async () => {
		const aw = await adoptWorld({ dumpRows: 60 });
		const code = await refused(aw, { restoreCeilingBytes: 300 });
		expect(code).toBe('restore_too_large');
		const step = (await operationOf(aw)).steps.find((entry) => entry.state === 'failed');
		expect(step?.id).toBe('export');
		expect(step?.error).toContain('300 bytes');
		expect(aw.world.sqlite.prepare('SELECT id FROM backups').all()).toEqual([]);
		expect(aw.blobs.objects.size).toBe(0);
	});

	it('stops after the first page that passes the ceiling', async () => {
		const aw = await adoptWorld({ dumpRows: 400 });
		await refused(aw, { restoreCeilingBytes: 1_300 });
		expect(aw.worker.calls.exports).toBe(3);
	});

	it('accepts a database exactly at the ceiling', async () => {
		const aw = await adoptWorld();
		const { outcome } = await run(aw, { patch: { restoreCeilingBytes: aw.dump.length } });
		expect(outcome).toEqual({ status: 'succeeded' });
	});

	it('refuses a site that was already adopted', async () => {
		const aw = await adoptWorld({ adoptedTo: `site_${'z'.repeat(26)}` });
		expect(await refused(aw)).toBe('already_adopted');
	});

	it('refuses a site that is not self-managed', async () => {
		const aw = await adoptWorld({ sourcePlane: 'managed' });
		expect(await refused(aw)).toBe('not_self_managed');
	});

	it('refuses a source without an owner token', async () => {
		const aw = await adoptWorld({ token: false });
		expect(await refused(aw)).toBe('no_owner_token');
	});

	it('refuses a source that answers with a server error', async () => {
		const aw = await adoptWorld({ probe: 503 });
		expect(await refused(aw)).toBe('source_unreachable');
	});

	it('refuses a source that holds files only in R2 before it exports anything', async () => {
		const aw = await adoptWorld({ offloaded: 3 });
		expect(await refused(aw)).toBe('files_outside_database');
		expect(aw.worker.calls.exports).toBe(0);
		expect(aw.worker.calls.restores).toEqual([]);
	});

	it('lifts the refusal when the source lists its offloaded files', async () => {
		const aw = await adoptWorld({ files: [file('public://a.bin', 'abc')] });
		const { outcome } = await run(aw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(aw.worker.calls.fetched).toEqual(['public://a.bin']);
	});

	it('adopts a source whose stats name no offloaded files', async () => {
		const aw = await adoptWorld({ offloaded: 0 });
		const { outcome } = await run(aw);
		expect(outcome).toEqual({ status: 'succeeded' });
	});

	it('refuses a kind whose first run gives no owner token', async () => {
		const aw = await adoptWorld();
		const input = inputOf(aw);
		const patch = {
			create: { ...input.create, firstRun: { ...input.create.firstRun, reads: {} } }
		};
		expect(await refused(aw, patch)).toBe('unsupported_kind');
	});

	it('refuses a source in another organisation', async () => {
		const aw = await adoptWorld();
		expect(await refused(aw, { orgId: `org_${'q'.repeat(26)}` })).toBe('site_not_ready');
	});
});

const FAIL_AT = [
	'source.export.start',
	'source.verify',
	'source.record',
	'target.reserve-name',
	'target.resource.CONFIG_KV',
	'target.assets.session',
	'target.upload-script',
	'target.authority',
	'target.route',
	'target.first-run',
	'link',
	'restore.check',
	'restore.restore',
	'restore.apply',
	'restore.verify',
	'target.activate'
];

describe('a failure at each step', () => {
	it.each(FAIL_AT)(
		'rolls back the new site and leaves the source alone after %s',
		async (step) => {
			const aw = await adoptWorld();
			const before = sourceRow(aw);
			const account = aw.world.cf.snapshot();
			const { outcome, executed } = await run(aw, {
				script: { failAt: { step, when: 'before' } }
			});
			expect(executed).toContain(step);
			expect(outcome.status).toBe('rolled-back');

			expect(sourceRow(aw)).toEqual(before);
			expect(aw.worker.sites.get(SRC_HOST)!.sql).toBe(aw.dump);
			expect(aw.worker.sites.get(SRC_HOST)!.imports).toEqual([]);
			// asset uploads wait for a script and cost nothing when none follows
			expect({ ...aw.world.cf.snapshot(), assets: [] }).toEqual(account);
			expect(targetRow(aw)).toMatchObject({ state: 'deleted' });
			expect(aw.world.sqlite.prepare('SELECT site_id FROM owner_tokens').all()).toEqual([
				{ site_id: SRC }
			]);
			expect(aw.world.leases.stateOf(SRC).holder ?? null).toBeNull();
			expect((await operationOf(aw)).status).toBe('rolled-back');
		}
	);

	it('keeps the recorded copy as a backup once it was saved', async () => {
		const aw = await adoptWorld();
		await run(aw, { script: { failAt: { step: 'restore.restore', when: 'before' } } });
		expect(await aw.deps.backups.get(aw.world.orgId, BACKUP_ID)).not.toBeNull();
		expect(aw.blobs.objects.size).toBeGreaterThan(0);
	});

	it('removes the copy parts when the failure comes before they were recorded', async () => {
		const aw = await adoptWorld();
		await run(aw, { script: { failAt: { step: 'source.record', when: 'before' } } });
		expect(await aw.deps.backups.get(aw.world.orgId, BACKUP_ID)).toBeNull();
		expect(aw.blobs.objects.size).toBe(0);
	});

	it('leaves a site that went live as it is', async () => {
		const aw = await adoptWorld();
		const { outcome } = await run(aw, {
			script: { failAt: { step: 'target.activate', when: 'after' } }
		});
		expect(outcome).toMatchObject({ status: 'failed', leaked: [] });
		expect(targetRow(aw)!.ready_at).not.toBeNull();
		expect(sourceRow(aw)).toMatchObject({ adopted_to: aw.world.siteId });
	});

	it('closes as failed and reports what leaked when the new site cannot be cleaned up', async () => {
		const aw = await adoptWorld();
		const original = aw.deps.leases.acquire;
		aw.deps.leases.acquire = async (siteId, request) =>
			siteId === aw.world.siteId && request.purpose === 'site.adopt'
				? { ok: false, code: 'held', heldBy: 'someone' }
				: original(siteId, request);
		const { outcome } = await run(aw, {
			script: { failAt: { step: 'target.route', when: 'before' } }
		});
		expect(outcome).toMatchObject({ status: 'failed', leaked: ['target'] });
		expect((await operationOf(aw)).status).toBe('failed');
		expect(sourceRow(aw)).toMatchObject({ adopted_to: null });
	});
});

describe('the adoption link', () => {
	it('marks the source once and takes the mark off only for the same target', async () => {
		const aw = await adoptWorld();
		const { store } = aw.world;
		const target = { id: aw.world.siteId, accountId: aw.world.accountId };
		expect(await store.linkAdoption(SRC, target, 1)).toBe(true);
		expect(await store.linkAdoption(SRC, target, 2)).toBe(true);
		expect(await store.linkAdoption(SRC, { ...target, id: `site_${'y'.repeat(26)}` }, 3)).toBe(
			false
		);
		await store.unlinkAdoption(SRC, `site_${'y'.repeat(26)}`, 4);
		expect(sourceRow(aw)).toMatchObject({ adopted_to: aw.world.siteId });
		await store.unlinkAdoption(SRC, aw.world.siteId, 5);
		expect(sourceRow(aw)).toMatchObject({ adopted_to: null });
	});
});

// #region files held only in object storage

// a dump as the site's own export writes it: the file tables, then the evicted row of each file
const evictedDump = (files: FakeFile[]) =>
	`${TABLES.join('\n')}\n` +
	files
		.map(
			(item) =>
				`INSERT INTO "cfw_file" ("uri", "size", "modified", "mime", "chunks", "mirrored", "rev", "touched", "evicted", "hash", "r2site") VALUES ('${item.uri}', ${item.bytes.byteLength}, 100, NULL, 1, 1, 7, 100, 1, '${'f'.repeat(64)}', 'site_${'z'.repeat(26)}');\n`
		)
		.join('');

const codeOfFailure = (outcome: { status: string; reason?: string }) =>
	/: ([a-z_]+): /.exec(outcome.reason ?? '')?.[1];

describe('adopting a site with files held only in object storage', () => {
	it('lands the bytes as resident rows and replaces the evicted ones, checked in a real database', async () => {
		const big = new Uint8Array(450_000).map((_, n) => n % 251);
		const files = [
			file('public://a.txt', 'hello', { contentType: 'text/plain', modified: 555 }),
			{ uri: 'private://big.bin', bytes: big },
			file('public://empty.txt', '')
		];
		const aw = await adoptWorld({ files, dump: evictedDump(files) });
		const { outcome, executed } = await run(aw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(executed).toEqual(expect.arrayContaining(['files-copy.0', 'files-copy.finish']));
		const body = aw.worker.sites.get(aw.world.input.hostname)!.sql;
		const db = new DatabaseSync(':memory:');
		for (const statement of splitLikeTheWorker(body).statements) db.exec(statement);
		const rows = db.prepare('SELECT * FROM cfw_file ORDER BY uri').all() as Record<
			string,
			unknown
		>[];
		expect(rows.map((row) => row.uri)).toEqual([
			'private://big.bin',
			'public://a.txt',
			'public://empty.txt'
		]);
		for (const row of rows) {
			expect(row).toMatchObject({
				evicted: 0,
				hash: null,
				r2site: null,
				mirrored: 0,
				rev: 1
			});
		}
		expect(rows[1]).toMatchObject({ size: 5, modified: 555, mime: 'text/plain', chunks: 1 });
		expect(rows[0]).toMatchObject({ size: 450_000, chunks: 3 });
		const read = (uri: string) => {
			const chunks = db
				.prepare('SELECT bytes FROM cfw_file_chunk WHERE uri = ? ORDER BY seq')
				.all(uri) as { bytes: Uint8Array }[];
			return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.bytes)));
		};
		expect(read('private://big.bin').equals(Buffer.from(big))).toBe(true);
		expect(read('public://a.txt').toString()).toBe('hello');
		expect(read('public://empty.txt')).toHaveLength(0);
		const queued = db.prepare('SELECT uri, op FROM cfw_file_mirror_queue ORDER BY uri').all();
		expect(queued).toHaveLength(3);
		expect(queued[0]).toMatchObject({ op: 'put' });
	});

	it('removes the stored statements once the site is live', async () => {
		const aw = await adoptWorld({ files: [file('public://a.txt', 'hello')] });
		await run(aw);
		expect(
			[...aw.blobs.objects.keys()].filter((key) => key.startsWith('copied-files/'))
		).toEqual([]);
	});

	it('pages the listing and takes the files in batches', async () => {
		const files = Array.from({ length: FILE_BATCH_FILES * 2 + 7 }, (_, n) =>
			file(`public://f${String(n).padStart(4, '0')}.txt`, `file ${n}`)
		);
		const aw = await adoptWorld({ files });
		const { outcome, executed } = await run(aw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(executed.filter((name) => /^files-copy\.\d+$/.test(name))).toEqual([
			'files-copy.0',
			'files-copy.1',
			'files-copy.2'
		]);
		// the first listing is the check before anything is exported
		expect(aw.worker.calls.listings.map((call) => call.limit)).toEqual([1, 50, 50, 50]);
		expect(aw.worker.calls.listings.map((call) => call.after)).toEqual([
			null,
			null,
			'public://f0049.txt',
			'public://f0099.txt'
		]);
		expect(aw.worker.calls.fetched).toHaveLength(files.length);
		expect(new Set(aw.worker.calls.fetched).size).toBe(files.length);
	});

	it('copies a file that fails once and succeeds on the second read', async () => {
		const files = [file('public://a.txt', 'hello'), file('public://b.txt', 'world')];
		const aw = await adoptWorld({ files });
		aw.worker.sites.get(SRC_HOST)!.fileFailures.set('public://a.txt', 1);
		const { outcome } = await run(aw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(aw.worker.calls.fetched.filter((uri) => uri === 'public://a.txt')).toHaveLength(2);
		expect(aw.worker.sites.get(aw.world.input.hostname)!.sql).toContain("'public://a.txt'");
	});

	it('fails the operation with a count when files fail twice, and names no path', async () => {
		const files = [
			file('public://secret-name-1.txt', 'one'),
			file('public://ok.txt', 'two'),
			file('public://secret-name-2.txt', 'three')
		];
		const aw = await adoptWorld({ files });
		const source = aw.worker.sites.get(SRC_HOST)!;
		source.fileFailures.set('public://secret-name-1.txt', 5);
		source.fileCorrupt.add('public://secret-name-2.txt');
		const { outcome } = await run(aw);
		expect(codeOfFailure(outcome)).toBe('files_copy_failed');
		expect(outcome.status).toBe('rolled-back');
		expect(outcome.status === 'succeeded' ? '' : outcome.reason).toContain('2 of 3 files');
		expect(outcome.status === 'succeeded' ? '' : outcome.reason).not.toContain('secret-name');
		expect(aw.worker.calls.fetched.filter((uri) => uri.includes('secret-name-1'))).toHaveLength(
			2
		);
		expect(aw.worker.calls.restores).toEqual([]);
		expect(aw.worker.calls.begins).toEqual([]);
		expect(targetRow(aw)).toMatchObject({ state: 'deleted', ready_at: null });
		expect(
			[...aw.blobs.objects.keys()].filter((key) => key.startsWith('copied-files/'))
		).toEqual([]);
	});

	it('carries a file larger than the batch cap on its own, through the paged restore', async () => {
		const big = new Uint8Array(9 * MIB).map((_, n) => (n * 7) % 253);
		const files = [file('public://a.txt', 'hello'), { uri: 'public://huge.bin', bytes: big }];
		const aw = await adoptWorld({ files, dump: evictedDump(files) });
		const { outcome, executed } = await run(aw, {
			patch: { restoreCeilingBytes: MAX_RESTORE_PAGED_BYTES }
		});
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(executed.filter((name) => /^files-copy\.\d+$/.test(name))).toEqual([
			'files-copy.0',
			'files-copy.1'
		]);
		expect(aw.worker.calls.restores).toEqual([]);
		expect(aw.worker.calls.begins).toHaveLength(1);
		const db = new DatabaseSync(':memory:');
		const body = aw.worker.sites.get(aw.world.input.hostname)!.sql;
		for (const statement of splitLikeTheWorker(body).statements) db.exec(statement);
		const chunks = db
			.prepare('SELECT bytes FROM cfw_file_chunk WHERE uri = ? ORDER BY seq')
			.all('public://huge.bin') as { bytes: Uint8Array }[];
		expect(
			Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.bytes))).equals(Buffer.from(big))
		).toBe(true);
	}, 30_000);

	it('refuses files that do not fit beside the database in one body and creates nothing', async () => {
		const big = new Uint8Array(9 * MIB).fill(5);
		const aw = await adoptWorld({ files: [{ uri: 'public://huge.bin', bytes: big }] });
		const { outcome } = await run(aw);
		expect(codeOfFailure(outcome)).toBe('restore_too_large');
		expect(aw.worker.calls.fetched).toEqual([]);
		expect(targetRow(aw)).toMatchObject({ state: 'deleted', ready_at: null });
	});

	it('refuses a site with more files than a copy carries', async () => {
		const files = Array.from({ length: MAX_COPIED_FILES + 1 }, (_, n) =>
			file(`public://f${String(n).padStart(5, '0')}`, '')
		);
		const aw = await adoptWorld({ files });
		const { outcome } = await run(aw);
		expect(codeOfFailure(outcome)).toBe('files_too_many');
		expect(aw.worker.calls.fetched).toEqual([]);
	}, 20_000);

	it('keeps the refusal when the source has no list route', async () => {
		const aw = await adoptWorld({ offloaded: 4 });
		const { outcome } = await run(aw);
		expect(codeOfFailure(outcome)).toBe('files_outside_database');
		expect(aw.worker.calls.listings).toEqual([]);
		expect(aw.worker.calls.exports).toBe(0);
	});

	it('stops when the route goes away after the check', async () => {
		const aw = await adoptWorld({ files: [file('public://a.txt', 'hello')] });
		let listings = 0;
		aw.deps.worker = backupWorkerOf(
			((input: string | URL | Request, init?: RequestInit) => {
				if (String(input).includes('/offloaded?limit=') && ++listings > 1) {
					return Promise.resolve(new Response('gone', { status: 404 }));
				}
				return aw.worker.fetcher(input, init);
			}) as typeof fetch,
			1_000
		);
		const { outcome } = await run(aw);
		expect(codeOfFailure(outcome)).toBe('files_unsupported');
		expect(aw.worker.calls.restores).toEqual([]);
	});

	it('refuses files that need the paged restore when the new site lacks it', async () => {
		const big = new Uint8Array(9 * MIB).fill(3);
		const aw = await adoptWorld({
			files: [{ uri: 'public://huge.bin', bytes: big }],
			target: { paged: false }
		});
		const { outcome } = await run(aw, {
			patch: { restoreCeilingBytes: MAX_RESTORE_PAGED_BYTES }
		});
		expect(codeOfFailure(outcome)).toBe('restore_unsupported');
		expect(aw.worker.calls.restores).toEqual([]);
		expect(aw.worker.calls.begins).toEqual([]);
	}, 30_000);

	it('keeps small files on the single route even when the new site lacks paging', async () => {
		const aw = await adoptWorld({
			files: [file('public://a.txt', 'hello')],
			target: { paged: false }
		});
		const { outcome } = await run(aw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(aw.worker.calls.restores).toHaveLength(1);
	});

	it('a copy killed while it reads a batch reads the same batch again and lands once', async () => {
		const files = Array.from({ length: 60 }, (_, n) =>
			file(`public://f${String(n).padStart(3, '0')}.txt`, `file ${n}`)
		);
		const reference = await adoptWorld({ files });
		const done = await run(reference);
		expect(done.outcome).toEqual({ status: 'succeeded' });
		const at = done.executed.indexOf('files-copy.0') + 1;
		const aw = await adoptWorld({ files });
		const memo: Memo = new Map();
		await expect(run(aw, { memo, script: { killDuring: at } })).rejects.toBeInstanceOf(Killed);
		const { outcome } = await run(aw, { memo });
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(aw.worker.sites.get(aw.world.input.hostname)!.sql.replaceAll(/\d{13}/g, 'T')).toBe(
			reference.worker.sites
				.get(reference.world.input.hostname)!
				.sql.replaceAll(/\d{13}/g, 'T')
		);
		expect(aw.worker.calls.restores).toHaveLength(1);
	});
});

// #endregion
