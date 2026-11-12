import type { D1Database } from '@cloudflare/workers-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../../contracts/src/common';
import { D1BackupLedger } from '../../../engine/src/adapters/backups';
import { backupWorkerOf } from '../../../engine/src/adapters/site';
import {
	BACKUP_ERROR_CODES,
	BackupError,
	backupKeys,
	buildManifest,
	checkPart,
	describePart,
	joinParts,
	manifestDigest,
	parseExportPage,
	parseManifest,
	restorable,
	type BackupErrorCode
} from '../../../engine/src/backup-parts';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import { NotOwnedError } from '../../../engine/src/ownership';
import type { BackupDeps } from '../../../engine/src/ports';
import { StepFailed } from '../../../engine/src/step';
import {
	planBackupCreate,
	runBackupCreate,
	type BackupCreateInput
} from '../../../engine/src/workflows/backup-create';
import {
	dropFileClone,
	grantFileClone,
	grantKey,
	planBackupRestore,
	runBackupRestore,
	type BackupRestoreInput
} from '../../../engine/src/workflows/backup-restore';
import type { Outcome } from '../../../engine/src/workflows/common';
import { dumpOf, fakeBlobs, fakeKv, fakeWorkers, MARKER } from './backup-fakes';
import {
	FAKE_OWNER_TOKEN,
	Killed,
	makeRunner,
	makeWorld,
	type Memo,
	type RunnerScript
} from './fakes';

const TARGET = `site_${'t'.repeat(26)}`;
const OTHER = `site_${'x'.repeat(26)}`;
const CREATE_OP = `op_${'c'.repeat(26)}`;
const RESTORE_OP = `op_${'r'.repeat(26)}`;
const BACKUP_ID = `bkp_${'b'.repeat(26)}`;
const SOURCE_HOST = 'source.drupflare.app';
const TARGET_HOST = 'target.drupflare.app';
const OTHER_HOST = 'other.drupflare.app';
const TARGET_CONFIG_KV = 'kvns-target-config';
const tripped = new Set<BackupErrorCode>();

function codeOf(reason: string): BackupErrorCode | undefined {
	const code = /^[\w.]+: ([a-z_]+): /.exec(reason)?.[1];
	return (BACKUP_ERROR_CODES as readonly string[]).includes(code ?? '')
		? (code as BackupErrorCode)
		: undefined;
}

function trip(outcome: Outcome, code: BackupErrorCode) {
	expect(outcome.status === 'succeeded' ? '' : codeOf(outcome.reason)).toBe(code);
	tripped.add(code);
}

interface WorldOptions {
	dumpRows?: number;
	ceiling?: number;
	files?: boolean;
	sourceOrg?: string;
	targetOrg?: string;
	targetState?: string;
	targetHost?: string | null;
	targetToken?: boolean;
	config?: boolean;
}

async function backupWorld(options: WorldOptions = {}) {
	const world = await makeWorld();
	const log: string[] = [];
	const db = (world.ledger as unknown as { db: D1Database }).db;
	const worker = fakeWorkers(log, options.ceiling);
	const blobs = fakeBlobs();
	const kv = fakeKv(log);
	const sourceId = world.siteId;
	const now = world.clock.now();
	const addSite = async (id: string, host: string | null, orgId: string, state = 'active') => {
		await world.store.activateSite(
			{
				id,
				organizationId: orgId,
				name: id,
				plane: 'managed',
				accountId: world.accountId,
				category: 'cms',
				config: 'managed'
			},
			now
		);
		world.sqlite
			.prepare('UPDATE sites SET primary_hostname = ?, state = ? WHERE id = ?')
			.run(host, state, id);
	};
	await addSite(sourceId, SOURCE_HOST, options.sourceOrg ?? world.orgId);
	await addSite(
		TARGET,
		options.targetHost === undefined ? TARGET_HOST : options.targetHost,
		options.targetOrg ?? world.orgId,
		options.targetState
	);
	await world.deps.custody.sealOwnerToken(sourceId, FAKE_OWNER_TOKEN);
	if (options.targetToken !== false)
		await world.deps.custody.sealOwnerToken(TARGET, FAKE_OWNER_TOKEN);
	const claim = async (
		siteId: string,
		kind: 'kv' | 'r2',
		binding: string,
		providerId: string
	) => {
		const { row } = await world.ledger.intend(
			{
				siteId,
				accountId: world.accountId,
				kind,
				binding,
				name: `${siteId}-${binding}`,
				operationId: 'op_seed'
			},
			now
		);
		await world.ledger.fill(row.id, providerId);
	};
	if (options.config !== false) await claim(TARGET, 'kv', 'CONFIG_KV', TARGET_CONFIG_KV);
	if (options.files !== false) await claim(sourceId, 'r2', 'FILES', 'bucket-source-files');
	const dump = dumpOf(options.dumpRows ?? 40);
	worker.add(SOURCE_HOST, sourceId, { sql: dump });
	worker.add(TARGET_HOST, TARGET, {
		sql: "INSERT INTO t VALUES (0, 'old');\n",
		adoptOnApply: options.files === false ? 0 : 2
	});
	const probes: string[] = [];
	const deps: BackupDeps = {
		...world.deps,
		site: {
			...world.deps.site,
			async probe(host, path, status, auth) {
				const state = worker.sites.get(host)?.imports.at(-1)?.state ?? 'none';
				log.push(`probe:${state}`);
				probes.push(host);
				return world.deps.site.probe(host, path, status, auth);
			}
		},
		worker: backupWorkerOf(worker.fetcher, 1_000),
		blobs: blobs.blobs,
		backups: new D1BackupLedger(db),
		kv: kv.kv,
		sleep: async (ms) => {
			world.clock.advance(ms);
			worker.alarm();
		}
	};
	return { world, deps, worker, blobs, kv, log, probes, sourceId, dump, db, claim, addSite };
}

type Bw = Awaited<ReturnType<typeof backupWorld>>;

const createInput = (bw: Bw, patch: Partial<BackupCreateInput> = {}): BackupCreateInput => ({
	operationId: CREATE_OP,
	orgId: bw.world.orgId,
	siteId: bw.sourceId,
	accountId: bw.world.accountId,
	backupId: BACKUP_ID,
	label: 'before the upgrade',
	...patch
});

const restoreInput = (bw: Bw, patch: Partial<BackupRestoreInput> = {}): BackupRestoreInput => ({
	operationId: RESTORE_OP,
	orgId: bw.world.orgId,
	backupId: BACKUP_ID,
	siteId: TARGET,
	accountId: bw.world.accountId,
	waitMs: 60_000,
	pollMs: 1_000,
	...patch
});

async function begin(
	bw: Bw,
	plan: Awaited<ReturnType<typeof freezePlan>>['plan'],
	input: { operationId: string; siteId: string }
) {
	const frozen = await freezePlan(plan);
	const operation = newOperation({
		id: input.operationId,
		orgId: bw.world.orgId,
		idempotencyKey: `key-${input.operationId}`,
		frozen,
		now: bw.world.clock.now()
	});
	await bw.world.store.begin({ operation, accountId: bw.world.accountId, siteId: input.siteId });
}

async function runCreate(
	bw: Bw,
	options: { memo?: Memo; script?: RunnerScript; patch?: Partial<BackupCreateInput> } = {}
) {
	const input = createInput(bw, options.patch);
	await begin(bw, planBackupCreate(input), input);
	const { runner, executed } = makeRunner(options.memo ?? new Map(), options.script);
	return { outcome: await runBackupCreate(runner, bw.deps, input), executed };
}

async function runRestore(
	bw: Bw,
	options: { memo?: Memo; script?: RunnerScript; patch?: Partial<BackupRestoreInput> } = {}
) {
	const input = restoreInput(bw, options.patch);
	await begin(bw, planBackupRestore(input), input);
	const { runner, executed } = makeRunner(options.memo ?? new Map(), options.script);
	return { outcome: await runBackupRestore(runner, bw.deps, input), executed };
}

async function backedUp(bw: Bw, patch: Partial<BackupCreateInput> = {}) {
	const { outcome } = await runCreate(bw, { patch });
	expect(outcome).toEqual({ status: 'succeeded' });
	const row = await bw.deps.backups.get(bw.world.orgId, BACKUP_ID);
	expect(row).not.toBeNull();
	return row!;
}

// #endregion

afterEach(() => vi.restoreAllMocks());

describe('the pure parts', () => {
	it('lays parts out under the backup prefix and refuses a key part that is not an id', () => {
		expect(backupKeys.part('org_a', 'site_b', 'bkp_c', 7)).toBe(
			'backups/org_a/site_b/bkp_c/part-00007.sql'
		);
		expect(backupKeys.manifest('org_a', 'site_b', 'bkp_c')).toBe(
			'backups/org_a/site_b/bkp_c/manifest.json'
		);
		expect(() => backupKeys.prefix('org_a/../x', 'site_b', 'bkp_c')).toThrow(BackupError);
		tripped.add('bad_key');
	});

	it('reads an export page and refuses one that is not a page, without quoting it', () => {
		expect(parseExportPage('{"sql":"A;","nextCursor":"p1","extra":1}')).toEqual({
			sql: 'A;',
			nextCursor: 'p1'
		});
		expect(parseExportPage('{"sql":"","nextCursor":null}').nextCursor).toBeNull();
		for (const text of ['nope', '{"sql":1}', '{"sql":"x","nextCursor":""}', '[]']) {
			try {
				parseExportPage(text);
				expect.unreachable();
			} catch (error) {
				expect(error).toBeInstanceOf(BackupError);
				expect((error as BackupError).code).toBe('export_unreadable');
				expect((error as Error).message).not.toContain('nope');
			}
		}
		tripped.add('export_unreadable');
	});

	it('round-trips a manifest and refuses one that does not add up', async () => {
		const parts = [
			await describePart(0, new Uint8Array([1, 2])),
			await describePart(1, new Uint8Array([3]))
		];
		const manifest = buildManifest({ id: BACKUP_ID, orgId: 'org_a', siteId: 'site_b', parts });
		expect(manifest.bytes).toBe(3);
		expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
		expect(await manifestDigest(manifest)).toMatch(/^[0-9a-f]{64}$/);
		const swapped = { ...manifest, parts: [manifest.parts[1], manifest.parts[0]] };
		for (const text of [
			'nope',
			JSON.stringify(swapped),
			JSON.stringify({ ...manifest, bytes: 9 })
		]) {
			expect(() => parseManifest(text)).toThrow(BackupError);
		}
		tripped.add('manifest_invalid');
	});

	it('checks a part by size and hash, and joins parts in order', async () => {
		const bytes = new Uint8Array([9, 8, 7]);
		const part = await describePart(0, bytes);
		await checkPart(part, bytes);
		await expect(checkPart(part, null)).rejects.toMatchObject({ code: 'part_missing' });
		await expect(checkPart(part, new Uint8Array([9, 8, 6]))).rejects.toMatchObject({
			code: 'part_changed'
		});
		expect(joinParts([new Uint8Array([1]), new Uint8Array([2, 3])])).toEqual(
			new Uint8Array([1, 2, 3])
		);
		expect(part.sha256).toBe(await sha256Hex(bytes));
		expect(restorable(10, 10)).toBe(true);
		expect(restorable(11, 10)).toBe(false);
		tripped.add('part_missing').add('part_changed');
	});
});

describe('backup.create', () => {
	it('pages the dump into parts, verifies them and records one unverified row', async () => {
		const bw = await backupWorld();
		const row = await backedUp(bw);
		const keys = [...bw.blobs.objects.keys()].sort();
		expect(keys.length).toBeGreaterThan(3);
		const manifestKey = backupKeys.manifest(bw.world.orgId, bw.sourceId, BACKUP_ID);
		expect(keys).toContain(manifestKey);
		const bytes = new TextEncoder().encode(bw.dump).byteLength;
		expect(row).toMatchObject({
			siteId: bw.sourceId,
			organizationId: bw.world.orgId,
			operationId: CREATE_OP,
			bytes,
			parts: keys.length - 1,
			restorable: true,
			verified: false,
			label: 'before the upgrade'
		});
		const manifest = parseManifest(new TextDecoder().decode(bw.blobs.objects.get(manifestKey)));
		expect(row.sha256).toBe(await manifestDigest(manifest));
		const stored = await Promise.all(
			manifest.parts.map((part) =>
				bw.blobs.objects.get(
					backupKeys.part(bw.world.orgId, bw.sourceId, BACKUP_ID, part.seq)
				)
			)
		);
		expect(new TextDecoder().decode(joinParts(stored as Uint8Array[]))).toBe(bw.dump);
		const operation = await bw.world.store.get(CREATE_OP);
		expect(operation).toMatchObject({ status: 'succeeded', verification: 'passed' });
		expect(operation!.steps.map((step) => step.state)).toEqual(Array(4).fill('succeeded'));
		expect(bw.world.leases.stateOf(bw.sourceId).holder).toBeNull();
	});

	it('only ever hands the worker the owner token from custody', async () => {
		const bw = await backupWorld();
		await backedUp(bw);
		expect([...bw.worker.bearers]).toEqual([`Bearer ${FAKE_OWNER_TOKEN}`]);
	});

	it('stops on a 409 page and records nothing', async () => {
		const bw = await backupWorld();
		bw.worker.sites.get(SOURCE_HOST)!.badPage = 2;
		const { outcome } = await runCreate(bw);
		trip(outcome, 'export_not_replayable');
		expect(outcome.status).toBe('rolled-back');
		expect(bw.blobs.objects.size).toBe(0);
		expect(await bw.deps.backups.get(bw.world.orgId, BACKUP_ID)).toBeNull();
		expect(await bw.world.store.get(CREATE_OP)).toMatchObject({ status: 'rolled-back' });
		expect(bw.world.leases.stateOf(bw.sourceId).holder).toBeNull();
	});

	it('stores a dump above the restore ceiling as not restorable', async () => {
		const bw = await backupWorld();
		const row = await backedUp(bw, { restoreCeilingBytes: 1_000 });
		expect(row.restorable).toBe(false);
		expect(row.bytes).toBeGreaterThan(1_000);
	});

	it('refuses a site that is not active, has no hostname or no owner token', async () => {
		for (const [patch, code] of [
			[{ targetState: 'tombstoned' }, 'site_not_ready'],
			[{ targetHost: null }, 'site_not_ready']
		] as const) {
			const bw = await backupWorld(patch);
			const { outcome } = await runCreate(bw, { patch: { siteId: TARGET } });
			trip(outcome, code);
			expect(bw.blobs.objects.size).toBe(0);
		}
		const bare = await backupWorld({ targetToken: false });
		trip((await runCreate(bare, { patch: { siteId: TARGET } })).outcome, 'no_owner_token');
		const foreign = await backupWorld({ targetOrg: 'org_zzzzzzzzzzzzzzzzzzzzzzzzzz' });
		trip((await runCreate(foreign, { patch: { siteId: TARGET } })).outcome, 'site_not_ready');
	});

	it('stops a dump that never ends and one that repeats its cursor', async () => {
		const long = await backupWorld();
		trip((await runCreate(long, { patch: { maxPages: 2 } })).outcome, 'export_too_long');
		expect(long.blobs.objects.size).toBe(0);
		const stalled = await backupWorld();
		stalled.worker.sites.get(SOURCE_HOST)!.stall = true;
		trip((await runCreate(stalled)).outcome, 'export_stalled');
		const garbage = await backupWorld();
		garbage.worker.sites.get(SOURCE_HOST)!.garbage = true;
		trip((await runCreate(garbage)).outcome, 'export_unreadable');
	});

	it('does not retry a refused token', async () => {
		const bw = await backupWorld();
		bw.worker.sites.get(SOURCE_HOST)!.token = 'a-different-token';
		const { outcome } = await runCreate(bw, { script: { retries: 3 } });
		trip(outcome, 'owner_token_rejected');
		expect(bw.worker.authFailures()).toBe(1);
	});

	it('records one row per operation when the record step runs twice', async () => {
		const bw = await backupWorld();
		const row = await backedUp(bw);
		const again = await bw.deps.backups.record({ ...row, id: 'bkp_second', bytes: 1 });
		expect(again.id).toBe(BACKUP_ID);
	});
});

describe('backup.restore', () => {
	it('restores a created backup into another site and probes it after the import applied', async () => {
		const bw = await backupWorld({ files: false });
		await backedUp(bw);
		const { outcome } = await runRestore(bw);
		expect(outcome).toEqual({ status: 'succeeded' });
		const target = bw.worker.sites.get(TARGET_HOST)!;
		expect(bw.worker.calls.restores).toHaveLength(1);
		expect(bw.worker.calls.restores[0]).toMatchObject({ host: TARGET_HOST, label: RESTORE_OP });
		expect(target.sql).toBe(bw.dump);
		expect(bw.log.filter((entry) => entry.startsWith('probe'))).toEqual(['probe:applied']);
		expect(await bw.world.store.get(RESTORE_OP)).toMatchObject({
			status: 'succeeded',
			verification: 'passed'
		});
		expect(bw.kv.puts).toEqual([]);
	});

	it('refuses a backup of another organisation and an unknown one', async () => {
		const bw = await backupWorld();
		await backedUp(bw);
		bw.world.sqlite
			.prepare('UPDATE backups SET organization_id = ?')
			.run('org_zzzzzzzzzzzzzzzzzzzzzzzzzz');
		trip((await runRestore(bw)).outcome, 'backup_not_found');
		const unknown = await backupWorld();
		trip((await runRestore(unknown)).outcome, 'backup_not_found');
		expect(bw.worker.calls.restores).toHaveLength(0);
		expect(unknown.worker.calls.restores).toHaveLength(0);
	});

	it('refuses an operation that belongs to another organisation', async () => {
		const bw = await backupWorld();
		await backedUp(bw);
		const input = restoreInput(bw, { orgId: 'org_zzzzzzzzzzzzzzzzzzzzzzzzzz' });
		await begin(bw, planBackupRestore(input), { ...input, operationId: RESTORE_OP });
		const { runner } = makeRunner(new Map());
		const outcome = await runBackupRestore(runner, bw.deps, input);
		trip(outcome, 'target_other_organisation');
		expect(bw.worker.calls.restores).toHaveLength(0);
	});

	it('refuses a backup above the ceiling and sends nothing', async () => {
		const bw = await backupWorld({ files: false });
		await backedUp(bw, { restoreCeilingBytes: 1_000 });
		const { outcome } = await runRestore(bw);
		trip(outcome, 'not_restorable');
		expect(bw.worker.calls.restores).toHaveLength(0);
		expect(bw.kv.puts).toEqual([]);
	});

	it('refuses a target that is not provisioned, has no token or sits in another organisation', async () => {
		const states = await backupWorld({ targetState: 'tombstoned' });
		await backedUp(states);
		trip((await runRestore(states)).outcome, 'target_not_ready');
		const bare = await backupWorld({ targetToken: false });
		await backedUp(bare);
		trip((await runRestore(bare)).outcome, 'no_owner_token');
		const foreign = await backupWorld({ targetOrg: 'org_zzzzzzzzzzzzzzzzzzzzzzzzzz' });
		await backedUp(foreign);
		trip((await runRestore(foreign)).outcome, 'target_other_organisation');
		for (const bw of [states, bare, foreign]) expect(bw.worker.calls.restores).toHaveLength(0);
	});

	it('does not retry a refused token and keeps it out of the failure text', async () => {
		const bw = await backupWorld({ files: false });
		await backedUp(bw);
		bw.worker.sites.get(TARGET_HOST)!.token = 'a-different-token';
		const { outcome } = await runRestore(bw, { script: { retries: 3 } });
		trip(outcome, 'owner_token_rejected');
		expect(bw.worker.authFailures()).toBe(1);
		expect(bw.worker.calls.restores).toHaveLength(0);
		expect(JSON.stringify(outcome)).not.toContain(FAKE_OWNER_TOKEN);
	});

	it('fails for good when the site refuses the dump as too large or refuses the restore', async () => {
		const big = await backupWorld({ files: false, ceiling: 100 });
		await backedUp(big);
		trip((await runRestore(big)).outcome, 'restore_too_large');
		const refused = await backupWorld({ files: false });
		await backedUp(refused);
		const original = refused.worker.fetcher;
		refused.deps.worker = backupWorkerOf(
			(async (input, init) =>
				new URL(String(input)).pathname === '/restore'
					? new Response('no', { status: 405 })
					: original(input, init)) as typeof fetch,
			1_000
		);
		trip((await runRestore(refused)).outcome, 'restore_rejected');
	});

	it('fails when the stored import fails and when it does not land in time', async () => {
		const failing = await backupWorld({ files: false });
		await backedUp(failing);
		failing.worker.sites.get(TARGET_HOST)!.failImport = true;
		const failed = (await runRestore(failing)).outcome;
		trip(failed, 'import_failed');
		if (failed.status === 'rolled-back' || failed.status === 'failed') {
			expect(failed.reason).toContain('at chunk 3 of 9: UNIQUE constraint failed: users.uid');
		}
		const slow = await backupWorld({ files: false });
		await backedUp(slow);
		slow.worker.sites.get(TARGET_HOST)!.applyAfter = 1_000;
		trip(
			(await runRestore(slow, { patch: { waitMs: 5_000, pollMs: 1_000 } })).outcome,
			'import_timeout'
		);
		expect(slow.probes).toEqual([]);
	});

	it('fails on a part that changed or went missing before sending anything', async () => {
		const changed = await backupWorld({ files: false });
		await backedUp(changed);
		const key = backupKeys.part(changed.world.orgId, changed.sourceId, BACKUP_ID, 0);
		changed.blobs.objects.set(key, new TextEncoder().encode('tampered'));
		trip((await runRestore(changed)).outcome, 'part_changed');
		const missing = await backupWorld({ files: false });
		await backedUp(missing);
		missing.blobs.objects.delete(
			backupKeys.part(missing.world.orgId, missing.sourceId, BACKUP_ID, 1)
		);
		trip((await runRestore(missing)).outcome, 'part_missing');
		const swapped = await backupWorld({ files: false });
		await backedUp(swapped);
		const manifestKey = backupKeys.manifest(swapped.world.orgId, swapped.sourceId, BACKUP_ID);
		const stored = parseManifest(
			new TextDecoder().decode(swapped.blobs.objects.get(manifestKey))
		);
		swapped.blobs.objects.set(
			manifestKey,
			new TextEncoder().encode(JSON.stringify({ ...stored, parts: [], bytes: 0 }))
		);
		trip((await runRestore(swapped)).outcome, 'manifest_changed');
		for (const bw of [changed, missing, swapped])
			expect(bw.worker.calls.restores).toHaveLength(0);
	});
});

describe('the file grant', () => {
	it('names the same-organisation source before the restore and removes the key after adoption', async () => {
		const bw = await backupWorld();
		await backedUp(bw);
		const { outcome } = await runRestore(bw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(bw.kv.puts).toEqual([
			{ namespaceId: TARGET_CONFIG_KV, key: grantKey(TARGET), value: bw.sourceId }
		]);
		const at = (entry: string) => bw.log.indexOf(entry);
		expect(at(`kv:put:${grantKey(TARGET)}`)).toBeLessThan(at(`restore:${TARGET}`));
		expect(at(`adopting:${TARGET}:0`)).toBeGreaterThan(at(`restore:${TARGET}`));
		expect(at(`kv:delete:${grantKey(TARGET)}`)).toBeGreaterThan(at(`adopting:${TARGET}:0`));
		expect(bw.kv.spaces.get(TARGET_CONFIG_KV)!.size).toBe(0);
		expect((await bw.world.store.get(RESTORE_OP))!.finalObservation!.summary).toContain(
			'must outlive the copy'
		);
	});

	it('writes no grant for a source with no files or a restore into the same site', async () => {
		const none = await backupWorld({ files: false });
		await backedUp(none);
		await runRestore(none);
		expect(none.kv.puts).toEqual([]);
		const same = await backupWorld();
		await backedUp(same);
		const { outcome } = await runRestore(same, { patch: { siteId: same.sourceId } });
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(same.kv.puts).toEqual([]);
	});

	it('refuses a source that sits in another organisation', async () => {
		const bw = await backupWorld();
		await backedUp(bw);
		bw.world.sqlite
			.prepare('UPDATE sites SET organization_id = ? WHERE id = ?')
			.run('org_zzzzzzzzzzzzzzzzzzzzzzzzzz', bw.sourceId);
		const { outcome } = await runRestore(bw);
		trip(outcome, 'grant_refused');
		expect(bw.kv.puts).toEqual([]);
		expect(bw.worker.calls.restores).toHaveLength(0);
	});

	it('refuses a grant for a namespace the target does not own, and one that is not a site id', async () => {
		const bw = await backupWorld();
		await bw.claim(OTHER, 'kv', 'CONFIG_KV', 'kvns-other-config');
		const claim = { siteId: TARGET, accountId: bw.world.accountId, plane: 'managed' as const };
		for (const namespaceId of ['kvns-not-on-record', 'kvns-other-config']) {
			await expect(
				grantFileClone(bw.deps, claim, namespaceId, [bw.sourceId])
			).rejects.toBeInstanceOf(NotOwnedError);
			await expect(dropFileClone(bw.deps, claim, namespaceId)).rejects.toBeInstanceOf(
				NotOwnedError
			);
		}
		await expect(
			grantFileClone(bw.deps, claim, TARGET_CONFIG_KV, ['not-a-site,site_other'])
		).rejects.toMatchObject({ code: 'grant_refused' });
		expect(bw.kv.puts).toEqual([]);
		expect(bw.kv.deletes).toEqual([]);
		tripped.add('grant_refused');
	});

	it('fails when the target has no config namespace on record', async () => {
		const bw = await backupWorld({ config: false });
		await backedUp(bw);
		const { outcome } = await runRestore(bw);
		trip(outcome, 'grant_no_namespace');
		expect(bw.worker.calls.restores).toHaveLength(0);
	});

	it('leaves the key in place when the copies do not finish in time', async () => {
		const bw = await backupWorld();
		await backedUp(bw);
		bw.worker.sites.get(TARGET_HOST)!.adoptOnApply = 1_000;
		const { outcome } = await runRestore(bw, { patch: { waitMs: 8_000, pollMs: 1_000 } });
		trip(outcome, 'adopting_timeout');
		expect(bw.kv.spaces.get(TARGET_CONFIG_KV)!.has(grantKey(TARGET))).toBe(true);
		expect(bw.kv.deletes).toEqual([]);
	});
});

// #region kill and resume

async function view(bw: Bw, operationId: string) {
	const operation = await bw.world.store.get(operationId);
	return (
		operation && {
			status: operation.status,
			verification: operation.verification,
			steps: operation.steps.map((step) => [step.id, step.state]),
			observation: operation.finalObservation?.summary ?? null
		}
	);
}

async function snapshot(bw: Bw) {
	const row = await bw.deps.backups.get(bw.world.orgId, BACKUP_ID);
	const objects = await Promise.all(
		[...bw.blobs.objects.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(async ([key, bytes]) => [key, await sha256Hex(bytes)])
	);
	return {
		create: await view(bw, CREATE_OP),
		restore: await view(bw, RESTORE_OP),
		backup: row && { ...row, createdAt: 0 },
		objects,
		lease: [bw.sourceId, TARGET].map((id) => bw.world.leases.stateOf(id).holder),
		restores: bw.worker.calls.restores.map((call) => [call.host, call.label, call.body.length]),
		targetSql: await sha256Hex(bw.worker.sites.get(TARGET_HOST)!.sql),
		kv: [...bw.kv.spaces.entries()].map(([space, keys]) => [space, [...keys.entries()]])
	};
}

async function killedAt(
	run: (bw: Bw, memo: Memo, script?: RunnerScript) => Promise<unknown>,
	make: () => Promise<Bw>,
	script: RunnerScript
) {
	const bw = await make();
	const memo: Memo = new Map();
	await expect(run(bw, memo, script)).rejects.toBeInstanceOf(Killed);
	await run(bw, memo);
	return snapshot(bw);
}

describe('kill and resume', () => {
	it('a create killed at any step, before or after its effect, converges to the uninterrupted run', async () => {
		const make = () => backupWorld();
		const reference = await make();
		const first = await runCreate(reference);
		const expected = await snapshot(reference);
		const steps = first.executed.length;
		expect(steps).toBeGreaterThan(8);
		const run = (bw: Bw, memo: Memo, script?: RunnerScript) => runCreate(bw, { memo, script });
		for (let k = 0; k < steps; k++) {
			expect(await killedAt(run, make, { killAfter: k })).toEqual(expected);
			expect(await killedAt(run, make, { killDuring: k + 1 })).toEqual(expected);
		}
	});

	it('resumes a create at the cursor stored with the operation in a new instance', async () => {
		const bw = await backupWorld();
		await expect(
			runCreate(bw, { memo: new Map(), script: { killAfter: 6 } })
		).rejects.toBeInstanceOf(Killed);
		const before = (await bw.world.store.get(CREATE_OP))!.cursor;
		expect(before).toMatch(/"seq":[1-9]/);
		const exportsBefore = bw.worker.calls.exports;
		const { outcome } = await runCreate(bw, { memo: new Map() });
		expect(outcome).toEqual({ status: 'succeeded' });
		const reference = await backupWorld();
		await backedUp(reference);
		expect(bw.worker.calls.exports - exportsBefore).toBeLessThan(
			reference.worker.calls.exports
		);
		expect(await snapshot(bw)).toEqual(await snapshot(reference));
	});

	it('a restore killed at any step, before or after its effect, converges and sends the dump once', async () => {
		const make = async () => {
			const bw = await backupWorld();
			await backedUp(bw);
			return bw;
		};
		const reference = await make();
		const first = await runRestore(reference);
		const expected = await snapshot(reference);
		const steps = first.executed.length;
		expect(steps).toBeGreaterThan(8);
		expect(expected.restores).toHaveLength(1);
		const run = (bw: Bw, memo: Memo, script?: RunnerScript) => runRestore(bw, { memo, script });
		for (let k = 0; k < steps; k++) {
			expect(await killedAt(run, make, { killAfter: k })).toEqual(expected);
			expect(await killedAt(run, make, { killDuring: k + 1 })).toEqual(expected);
		}
	});
});

// #endregion

describe('the secret scan', () => {
	it('keeps the token and the dump out of step results, rows, outcomes and log lines', async () => {
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
			vi.spyOn(console, name).mockImplementation(() => undefined)
		);
		const memos: Memo[] = [new Map(), new Map(), new Map(), new Map()];
		const bw = await backupWorld();
		const created = await runCreate(bw, { memo: memos[0] });
		const restored = await runRestore(bw, { memo: memos[1] });
		const refused = await backupWorld({ files: false });
		refused.worker.sites.get(SOURCE_HOST)!.badPage = 1;
		const failed = await runCreate(refused, { memo: memos[2] });
		const wrong = await backupWorld({ files: false });
		wrong.worker.sites.get(SOURCE_HOST)!.token = 'a-different-token';
		const denied = await runCreate(wrong, { memo: memos[3] });
		const outcomes = [created.outcome, restored.outcome, failed.outcome, denied.outcome];
		expect(outcomes.map((outcome) => outcome.status)).toEqual([
			'succeeded',
			'succeeded',
			'rolled-back',
			'rolled-back'
		]);
		const tables = [
			'operations',
			'operation_steps',
			'backups',
			'site_resources',
			'owner_tokens'
		];
		const texts = [
			...memos.map((memo) => JSON.stringify([...memo.entries()])),
			JSON.stringify(outcomes),
			...[bw, refused, wrong].flatMap((world) =>
				tables.map((table) =>
					JSON.stringify(world.world.sqlite.prepare(`SELECT * FROM ${table}`).all())
				)
			),
			...spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call)))
		];
		const secrets = [FAKE_OWNER_TOKEN, MARKER, 'a-different-token'];
		for (const text of texts) for (const secret of secrets) expect(text).not.toContain(secret);
		// the scan can see a secret when one is there
		expect(
			JSON.stringify(
				[...bw.blobs.objects.values()].map((bytes) => new TextDecoder().decode(bytes))
			)
		).toContain(MARKER);
	});
});

describe('the worker adapter', () => {
	it('stays on the site host, encodes the cursor and sends the token as a bearer', async () => {
		const seen: { url: string; auth: string | null }[] = [];
		const worker = backupWorkerOf(
			(async (input, init) => {
				seen.push({
					url: String(input),
					auth: new Headers(init?.headers).get('authorization')
				});
				return Response.json({ sql: 'x', nextCursor: null });
			}) as typeof fetch,
			1_000
		);
		await worker.exportPage('a.drupflare.app', '{"phase":"ddl"}', { bearer: 't' });
		expect(seen[0]).toEqual({
			url: 'https://a.drupflare.app/export?cursor=%7B%22phase%22%3A%22ddl%22%7D&body=1',
			auth: 'Bearer t'
		});
		expect(seen[0]!.url).not.toContain('secrets');
		await expect(worker.exportPage('bad host', 'start', { bearer: 't' })).rejects.toBeDefined();
	});

	it('maps each answer to a typed error or a retryable one', async () => {
		const answering = (status: number, body = '{}') =>
			backupWorkerOf((async () => new Response(body, { status })) as typeof fetch, 1_000);
		await expect(
			answering(401).exportPage('h.app', 'start', { bearer: 't' })
		).rejects.toMatchObject({
			code: 'owner_token_rejected'
		});
		await expect(
			answering(409).exportPage('h.app', 'start', { bearer: 't' })
		).rejects.toMatchObject({
			code: 'export_not_replayable'
		});
		await expect(
			answering(400).exportPage('h.app', 'start', { bearer: 't' })
		).rejects.toMatchObject({
			code: 'export_unreadable'
		});
		const retryable = await answering(503)
			.exportPage('h.app', 'start', { bearer: 't' })
			.catch((error: unknown) => error);
		expect(retryable).toBeInstanceOf(Error);
		expect(retryable).not.toBeInstanceOf(BackupError);
		await expect(
			answering(413).restore('h.app', new Uint8Array(), 'l', { bearer: 't' })
		).rejects.toMatchObject({
			code: 'restore_too_large'
		});
		await expect(
			answering(400).restore('h.app', new Uint8Array(), 'l', { bearer: 't' })
		).rejects.toMatchObject({
			code: 'restore_rejected'
		});
		await expect(
			answering(200, 'not json').restore('h.app', new Uint8Array(), 'l', { bearer: 't' })
		).rejects.toThrow('the restore answer was not readable');
		await expect(
			answering(200, '{"storage":{}}').adopting('h.app', { bearer: 't' })
		).rejects.toThrow();
		await expect(
			answering(503).importState('h.app', 'l', { bearer: 't' })
		).rejects.toBeInstanceOf(Error);
		const health = (body: unknown) => answering(200, JSON.stringify(body));
		expect(await health({ import: null }).importState('h.app', 'l', { bearer: 't' })).toBe(
			'absent'
		);
		expect(
			await health({ import: { generation: 'other', state: 'applied' } }).importState(
				'h.app',
				'l',
				{
					bearer: 't'
				}
			)
		).toBe('absent');
		expect(
			await health({ import: { generation: 'l', state: 'failed' } }).importState(
				'h.app',
				'l',
				{
					bearer: 't'
				}
			)
		).toBe('failed');
		const reason = (stored: object | null) =>
			health({ import: stored }).importReason('h.app', 'l', { bearer: 't' });
		expect(
			await reason({
				generation: 'l',
				state: 'failed',
				chunk: 3,
				chunks: 9,
				error: 'UNIQUE constraint failed: users.uid'
			})
		).toBe('chunk 3 of 9: UNIQUE constraint failed: users.uid');
		expect(await reason({ generation: 'l', state: 'failed', error: 'x' })).toBe('x');
		expect(await reason({ generation: 'l', state: 'failed', chunk: 1, chunks: 2 })).toBe(
			'chunk 1 of 2'
		);
		expect(await reason({ generation: 'other', state: 'failed', error: 'x' })).toBe('');
		expect(await reason(null)).toBe('');
		const long = await reason({
			generation: 'l',
			state: 'failed',
			error: `a\u0000b\n${'z'.repeat(1000)}`
		});
		expect(long).toHaveLength(300);
		expect(long).not.toMatch(/[\u0000-\u001f]/);
		tripped
			.add('owner_token_rejected')
			.add('export_not_replayable')
			.add('restore_too_large')
			.add('restore_rejected');
	});

	it('leaves a step runner failure typed as the step that failed', () => {
		expect(new StepFailed('export.page.1', new BackupError('part_changed', 'x')).step).toBe(
			'export.page.1'
		);
	});
});

describe('every typed error', () => {
	it('is tripped once by the cases above', () => {
		expect([...tripped].sort()).toEqual([...BACKUP_ERROR_CODES].sort());
	});
});
