import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { scriptName } from '../../../contracts/src/sites';
import { D1AccessLedger } from '../../../engine/src/adapters/access';
import { D1BackupLedger } from '../../../engine/src/adapters/backups';
import { D1CopyStore } from '../../../engine/src/adapters/copies';
import { backupWorkerOf } from '../../../engine/src/adapters/site';
import { TEMPORARY_TAG } from '../../../engine/src/descriptor';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { CopyDeps } from '../../../engine/src/ports';
import { planBackupCreate, runBackupCreate } from '../../../engine/src/workflows/backup-create';
import { planBackupVerify, runBackupVerify } from '../../../engine/src/workflows/backup-verify';
import {
	planEnvCreate,
	runEnvCreate,
	type EnvCreateInput
} from '../../../engine/src/workflows/env-create';
import {
	planEnvDelete,
	runEnvDelete,
	type EnvDeleteInput
} from '../../../engine/src/workflows/env-delete';
import type { CopyInput } from '../../../engine/src/workflows/restored-copy';
import { dumpOf, fakeBlobs, fakeKv, fakeWorkers, MARKER } from './backup-fakes';
import { FAKE_OWNER_TOKEN, Killed, makeRunner, makeWorld, type Memo } from './fakes';

const SRC = `site_${'a'.repeat(26)}`;
const SRC_HOST = 'source.drupflare.app';
const SRC_BUCKET = 'bucket-source-files';
const BACKUP_ID = `bkp_${'b'.repeat(26)}`;
const BACKUP_OP = `op_${'c'.repeat(26)}`;
const ENV_ID = `env_${'e'.repeat(26)}`;
const OTHER = `site_${'z'.repeat(26)}`;

interface Options {
	files?: boolean;
	probe?: number;
	failImport?: boolean;
	dumpRows?: number;
}

async function copyWorld(options: Options = {}) {
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
			name: 'Production',
			plane: 'managed',
			accountId: world.accountId,
			category: 'cms',
			config: 'managed'
		},
		now
	);
	world.sqlite.prepare('UPDATE sites SET primary_hostname = ? WHERE id = ?').run(SRC_HOST, SRC);
	await world.deps.custody.sealOwnerToken(SRC, FAKE_OWNER_TOKEN);
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
	await claim(SRC, 'kv', 'CONFIG_KV', 'kvns-source-config');
	if (options.files) await claim(SRC, 'r2', 'FILES', SRC_BUCKET);
	const dump = dumpOf(options.dumpRows ?? 40);
	worker.add(SRC_HOST, SRC, { sql: dump });
	// the hidden row a request writes for the copy, which the engine activates last
	world.sqlite
		.prepare(
			`INSERT INTO sites (id, organization_id, name, plane, state, primary_hostname, created_at,
			updated_at) VALUES (?, ?, 'Production (Staging)', 'managed', 'active', ?, ?, ?)`
		)
		.run(world.siteId, world.orgId, world.input.hostname, now, now);
	worker.add(world.input.hostname, world.siteId, {
		sql: '',
		adoptOnApply: options.files ? 2 : 0,
		failImport: options.failImport ?? false
	});
	world.sqlite
		.prepare(
			`INSERT INTO site_environments (id, organization_id, site_id, kind, name, host, status,
			env_site_id, source_backup_id, ttl_at, created_at, deleted_at)
			VALUES (?, ?, ?, 'staging', 'quiet-otter', ?, 'creating', ?, ?, NULL, ?, NULL)`
		)
		.run(ENV_ID, world.orgId, SRC, world.input.hostname, world.siteId, BACKUP_ID, now);
	if (options.probe !== undefined) world.site.answers.probe = options.probe;
	const copies = new D1CopyStore(db);
	const deps: CopyDeps = {
		...world.deps,
		worker: backupWorkerOf(worker.fetcher, 1_000),
		blobs: blobs.blobs,
		backups: new D1BackupLedger(db),
		kv: kv.kv,
		sleep: async (ms) => {
			world.clock.advance(ms);
			worker.alarm();
		},
		environments: copies,
		verifications: copies,
		access: new D1AccessLedger(db)
	};
	return { world, deps, worker, blobs, log, dump, db, claim };
}

type Cw = Awaited<ReturnType<typeof copyWorld>>;

async function begin(
	cw: Cw,
	plan: Awaited<ReturnType<typeof freezePlan>>['plan'],
	operationId: string,
	siteId: string,
	verification?: 'not-required'
) {
	const frozen = await freezePlan(plan);
	const operation = newOperation({
		id: operationId,
		orgId: cw.world.orgId,
		idempotencyKey: `key-${operationId}`,
		frozen,
		verification,
		now: cw.world.clock.now()
	});
	await cw.world.store.begin({ operation, accountId: cw.world.accountId, siteId });
}

async function backedUp(cw: Cw) {
	const input = {
		operationId: BACKUP_OP,
		orgId: cw.world.orgId,
		siteId: SRC,
		accountId: cw.world.accountId,
		backupId: BACKUP_ID,
		label: 'before the change'
	};
	await begin(cw, planBackupCreate(input), BACKUP_OP, SRC);
	const { runner } = makeRunner(new Map());
	expect(await runBackupCreate(runner, cw.deps, input)).toEqual({ status: 'succeeded' });
}

const copyInput = (cw: Cw, patch: Partial<CopyInput> = {}): CopyInput => ({
	operationId: cw.world.operationId,
	orgId: cw.world.orgId,
	backupId: BACKUP_ID,
	create: { ...cw.world.input, temporary: true } as CopyInput['create'],
	waitMs: 60_000,
	pollMs: 1_000,
	...patch
});

const envInput = (cw: Cw, patch: Partial<EnvCreateInput> = {}): EnvCreateInput => ({
	...copyInput(cw),
	environment: { id: ENV_ID },
	...patch
});

async function runVerify(cw: Cw, options: { memo?: Memo; killAfter?: number } = {}) {
	const input = copyInput(cw);
	if (options.memo === undefined || options.memo.size === 0) {
		await begin(cw, planBackupVerify(input), input.operationId, cw.world.siteId);
	}
	const { runner, executed } = makeRunner(options.memo ?? new Map(), {
		killAfter: options.killAfter
	});
	return { outcome: await runBackupVerify(runner, cw.deps, input), executed };
}

async function runCreate(cw: Cw) {
	const input = envInput(cw);
	await begin(cw, planEnvCreate(input), input.operationId, cw.world.siteId);
	const { runner } = makeRunner(new Map());
	return runEnvCreate(runner, cw.deps, input);
}

const verifiedOf = (cw: Cw) =>
	cw.world.sqlite.prepare('SELECT verified FROM backups WHERE id = ?').get(BACKUP_ID)
		?.verified as number | undefined;

const siteRow = (cw: Cw, id = cw.world.siteId) =>
	cw.world.sqlite.prepare('SELECT state, ready_at FROM sites WHERE id = ?').get(id);

const envRow = (cw: Cw) =>
	cw.world.sqlite
		.prepare('SELECT status, deleted_at FROM site_environments WHERE id = ?')
		.get(ENV_ID);

const operationOf = async (cw: Cw) => (await cw.world.store.get(cw.world.operationId))!;

// what the account holds for the production site must not move in any run of these workflows
const productionIntact = (cw: Cw) => {
	const source = cw.worker.sites.get(SRC_HOST)!;
	expect(source.sql).toBe(cw.dump);
	expect(source.imports).toEqual([]);
	expect(cw.worker.calls.restores.every((call) => call.host !== SRC_HOST)).toBe(true);
};

describe('backup verify', () => {
	it('plans the scratch site as the only target, with unique step ids', async () => {
		const cw = await copyWorld();
		const plan = planBackupVerify(copyInput(cw));
		expect(plan.type).toBe('backup.verify');
		expect(plan.targetIds).toEqual([cw.world.siteId]);
		const ids = plan.steps.map((step) => step.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.slice(-3)).toEqual(['verify', 'cleanup', 'record']);
	});

	it('marks the backup verified after the probes pass and removes the scratch site', async () => {
		const cw = await copyWorld({ files: true });
		await backedUp(cw);
		expect(verifiedOf(cw)).toBe(0);

		const { outcome } = await runVerify(cw);

		expect(outcome).toEqual({ status: 'succeeded' });
		expect(verifiedOf(cw)).toBe(1);
		expect(cw.worker.calls.restores.map((call) => call.host)).toEqual([
			cw.world.input.hostname
		]);
		expect(cw.worker.sites.get(cw.world.input.hostname)!.sql).toBe(cw.dump);
		expect(cw.dump).toContain(MARKER);
		productionIntact(cw);
		const operation = await operationOf(cw);
		expect(operation.status).toBe('succeeded');
		expect(operation.verification).toBe('passed');
		expect(operation.steps.every((step) => step.state === 'succeeded')).toBe(true);
		expect(await cw.world.ledger.live(cw.world.siteId)).toEqual([]);
		expect(cw.world.cf.snapshot()).toMatchObject({ kv: [], r2: [], scripts: [] });
		expect(siteRow(cw)).toMatchObject({ state: 'deleted', ready_at: null });
	});

	it('tags the scratch script so a sweep can find it', async () => {
		const cw = await copyWorld();
		await backedUp(cw);
		await runVerify(cw);
		const tags = cw.world.cf.uploads.at(-1)!.tags;
		expect(tags).toContain(TEMPORARY_TAG);
		expect(tags.length).toBeLessThanOrEqual(8);
	});

	it('leaves the backup unverified when a probe fails, says why, and still removes the scratch site', async () => {
		const cw = await copyWorld({ files: true, probe: 500 });
		await backedUp(cw);

		const { outcome } = await runVerify(cw);

		expect(outcome.status).toBe('failed');
		expect(verifiedOf(cw)).toBe(0);
		const operation = await operationOf(cw);
		expect(operation.status).toBe('failed');
		const failed = operation.steps.find((step) => step.state === 'failed');
		expect(failed?.id).toBe('verify');
		expect(failed?.error).toContain('answered 500');
		expect(operation.finalObservation?.summary).toContain('the copy was removed');
		expect(await cw.world.ledger.live(cw.world.siteId)).toEqual([]);
		expect(cw.world.cf.snapshot()).toMatchObject({ kv: [], r2: [], scripts: [] });
		expect(siteRow(cw)).toMatchObject({ state: 'deleted' });
		productionIntact(cw);
	});

	it('leaves the backup unverified when the restore itself fails', async () => {
		const cw = await copyWorld({ failImport: true });
		await backedUp(cw);
		const { outcome } = await runVerify(cw);
		expect(outcome.status).toBe('failed');
		expect(verifiedOf(cw)).toBe(0);
		expect((await operationOf(cw)).steps.find((step) => step.state === 'failed')?.id).toBe(
			'apply'
		);
		expect(cw.world.cf.snapshot()).toMatchObject({ kv: [], scripts: [] });
	});

	it('refuses a backup that is not in the organisation before it creates anything', async () => {
		const cw = await copyWorld();
		const input = copyInput(cw, { backupId: `bkp_${'q'.repeat(26)}` });
		await begin(cw, planBackupVerify(input), input.operationId, cw.world.siteId);
		const { runner } = makeRunner(new Map());
		const outcome = await runBackupVerify(runner, cw.deps, input);
		expect(outcome.status).toBe('failed');
		expect(outcome.status === 'failed' ? outcome.reason : '').toContain('backup_not_found');
		expect(cw.world.cf.counts.create).toBe(0);
		expect(verifiedOf(cw)).toBeUndefined();
	});

	it('picks up after a run that was killed halfway without leaking or restoring twice', async () => {
		const cw = await copyWorld({ files: true });
		await backedUp(cw);
		const memo: Memo = new Map();
		await runVerify(cw, { memo, killAfter: 14 }).then(
			() => expect.unreachable('the run should have been killed'),
			(error) => expect(error).toBeInstanceOf(Killed)
		);
		expect(verifiedOf(cw)).toBe(0);
		expect(
			cw.world.cf.snapshot().scripts.length + cw.world.cf.snapshot().kv.length
		).toBeGreaterThan(0);

		const first = [...memo.keys()];
		const { outcome, executed } = await runVerify(cw, { memo });

		expect(outcome).toEqual({ status: 'succeeded' });
		expect(executed.some((name) => first.includes(name))).toBe(false);
		expect(cw.worker.calls.restores).toHaveLength(1);
		expect(verifiedOf(cw)).toBe(1);
		expect(await cw.world.ledger.live(cw.world.siteId)).toEqual([]);
		expect(cw.world.cf.snapshot()).toMatchObject({ kv: [], r2: [], scripts: [] });
	});
});

describe('environment create', () => {
	it('plans the new site as the only target and activates it last', async () => {
		const cw = await copyWorld();
		const plan = planEnvCreate(envInput(cw));
		expect(plan.type).toBe('env.create');
		expect(plan.targetIds).toEqual([cw.world.siteId]);
		const ids = plan.steps.map((step) => step.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.at(-1)).toBe('activate');
		expect(ids.indexOf('first-run')).toBeLessThan(ids.indexOf('restore'));
	});

	it('restores the saved copy into a new isolated site and never writes the source', async () => {
		const cw = await copyWorld({ files: true });
		await backedUp(cw);
		const sourceBefore = (await cw.world.ledger.live(SRC)).map((row) => row.providerId);
		const kvWrites = cw.log.length;

		const outcome = await runCreate(cw);

		expect(outcome).toEqual({ status: 'succeeded' });
		expect(cw.worker.calls.restores.map((call) => call.host)).toEqual([
			cw.world.input.hostname
		]);
		expect(cw.worker.sites.get(cw.world.input.hostname)!.sql).toBe(cw.dump);
		productionIntact(cw);
		// the copy owns its own storage: none of its provider ids is one the source holds
		const own = (await cw.world.ledger.live(cw.world.siteId)).map((row) => row.providerId);
		expect(own.length).toBeGreaterThan(0);
		expect(own.filter((id) => sourceBefore.includes(id))).toEqual([]);
		expect(own).not.toContain(SRC_BUCKET);
		// the file grant is written to the copy's own config store and dropped again
		expect(cw.log.slice(kvWrites).filter((line) => line.startsWith('kv:'))).toEqual([
			`kv:put:file_clone:${cw.world.siteId}`,
			`kv:delete:file_clone:${cw.world.siteId}`
		]);
		expect(siteRow(cw)!.ready_at).not.toBeNull();
		expect(envRow(cw)).toMatchObject({ status: 'ready', deleted_at: null });
		const operation = await operationOf(cw);
		expect(operation.status).toBe('succeeded');
		expect(operation.finalObservation?.summary).toContain('secrets were not carried');
		expect((await cw.world.ledger.live(SRC)).map((row) => row.providerId)).toEqual(
			sourceBefore
		);
	});

	it('routes the copy host to its environment and gates it before it is marked ready', async () => {
		const cw = await copyWorld();
		await backedUp(cw);

		expect(await runCreate(cw)).toEqual({ status: 'succeeded' });

		const snapshot = cw.world.authority.snapshot();
		const route = snapshot.hosts.find(([host]) => host === cw.world.input.hostname)![1];
		expect(route.environment).toBe(ENV_ID);
		const state = cw.world.authority.stateOf(cw.world.siteId)!;
		expect(Object.keys(state.gates ?? {})).toEqual([ENV_ID]);
		expect(state.accessRuleHash).not.toBe(cw.world.input.authority.accessRuleHash);
		expect(envRow(cw)).toMatchObject({ status: 'ready' });
	});

	it('does not mark the environment ready when it cannot be gated', async () => {
		const cw = await copyWorld();
		await backedUp(cw);
		cw.world.sqlite
			.prepare('UPDATE site_environments SET deleted_at = 1 WHERE id = ?')
			.run(ENV_ID);

		const outcome = await runCreate(cw);

		expect(outcome.status).not.toBe('succeeded');
		expect(cw.world.authority.stateOf(cw.world.siteId)?.gates).toBeUndefined();
	});

	it('removes what it made and marks the environment failed when the restore fails', async () => {
		const cw = await copyWorld({ failImport: true });
		await backedUp(cw);

		const outcome = await runCreate(cw);

		expect(outcome.status).toBe('rolled-back');
		expect(envRow(cw)).toMatchObject({ status: 'failed' });
		expect(siteRow(cw)).toMatchObject({ state: 'deleted', ready_at: null });
		expect(await cw.world.ledger.live(cw.world.siteId)).toEqual([]);
		expect(cw.world.cf.snapshot()).toMatchObject({ kv: [], r2: [], scripts: [] });
		productionIntact(cw);
	});

	it('keeps a copy that went live before a later failure, reading ready', async () => {
		const cw = await copyWorld();
		await backedUp(cw);
		const input = envInput(cw);
		await begin(cw, planEnvCreate(input), input.operationId, cw.world.siteId);
		const { runner } = makeRunner(new Map(), { failAt: { step: 'activate', when: 'after' } });

		const outcome = await runEnvCreate(runner, cw.deps, input);

		expect(outcome.status).toBe('failed');
		expect(envRow(cw)).toMatchObject({ status: 'ready' });
		expect(siteRow(cw)!.ready_at).not.toBeNull();
		expect((await cw.world.ledger.live(cw.world.siteId)).length).toBeGreaterThan(0);
	});
});

describe('environment delete', () => {
	const deleteInput = (cw: Cw): EnvDeleteInput => ({
		operationId: `op_${'d'.repeat(26)}`,
		orgId: cw.world.orgId,
		environment: { id: ENV_ID },
		siteId: cw.world.siteId,
		accountId: cw.world.accountId,
		plane: 'managed',
		hostname: cw.world.input.hostname,
		subdomain: cw.world.input.subdomain
	});

	async function runDelete(cw: Cw, patch: Partial<EnvDeleteInput> = {}) {
		const input = { ...deleteInput(cw), ...patch };
		await begin(cw, planEnvDelete(input), input.operationId, input.siteId, 'not-required');
		const { runner } = makeRunner(new Map());
		return runEnvDelete(runner, cw.deps, input);
	}

	it('purges the copy and only what its own ledger records', async () => {
		const cw = await copyWorld({ files: true });
		await backedUp(cw);
		expect(await runCreate(cw)).toEqual({ status: 'succeeded' });
		// a customer's storage and another site's ledger row are in the same account
		cw.world.cf.seedCustomer();
		await cw.claim(OTHER, 'kv', 'CONFIG_KV', 'kvns-other-config');
		const customers = cw.world.cf.snapshot();
		const sourceRows = (await cw.world.ledger.live(SRC)).map((row) => row.providerId);

		const outcome = await runDelete(cw);

		expect(outcome).toEqual({ status: 'succeeded' });
		const after = cw.world.cf.snapshot();
		const own = (name: string) => name.startsWith(scriptName(cw.world.siteId));
		expect(customers.kv.some(([, title]) => own(title))).toBe(true);
		expect(after.scripts.filter((line) => own(line))).toEqual([]);
		expect(after.kv).toEqual(customers.kv.filter(([, title]) => !own(title)));
		expect(after.r2).toEqual(customers.r2.filter((name) => !own(name)));
		expect(after.kv.length).toBeGreaterThan(0);
		expect(await cw.world.ledger.live(cw.world.siteId)).toEqual([]);
		expect((await cw.world.ledger.live(SRC)).map((row) => row.providerId)).toEqual(sourceRows);
		expect((await cw.world.ledger.live(OTHER)).map((row) => row.providerId)).toEqual([
			'kvns-other-config'
		]);
		expect(siteRow(cw)).toMatchObject({ state: 'deleted' });
		expect(envRow(cw)).toMatchObject({ status: 'deleted' });
		expect(envRow(cw)!.deleted_at).not.toBeNull();
		const operation = await cw.world.store.get(deleteInput(cw).operationId);
		expect(operation?.status).toBe('succeeded');
		productionIntact(cw);
	});

	it('leaves the environment ready after a failed delete and finishes it in the next one', async () => {
		const cw = await copyWorld();
		await backedUp(cw);
		expect(await runCreate(cw)).toEqual({ status: 'succeeded' });
		const input = deleteInput(cw);
		await begin(cw, planEnvDelete(input), input.operationId, input.siteId, 'not-required');
		const first = makeRunner(new Map(), { failAt: { step: 'resources', when: 'before' } });
		const failed = await runEnvDelete(first.runner, cw.deps, input);
		expect(failed.status).toBe('failed');
		expect(envRow(cw)).toMatchObject({ status: 'ready' });
		expect(cw.world.cf.snapshot().scripts).toEqual([]);

		const again = { ...input, operationId: `op_${'f'.repeat(26)}` };
		await begin(cw, planEnvDelete(again), again.operationId, again.siteId, 'not-required');
		const second = makeRunner(new Map());
		expect(await runEnvDelete(second.runner, cw.deps, again)).toEqual({ status: 'succeeded' });
		expect(envRow(cw)).toMatchObject({ status: 'deleted' });
		expect(cw.world.cf.snapshot()).toMatchObject({ kv: [], r2: [], scripts: [] });
	});
});
