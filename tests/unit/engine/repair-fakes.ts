import type { D1Database } from '@cloudflare/workers-types';
import { D1BackupLedger } from '../../../engine/src/adapters/backups';
import { D1RepairLedger } from '../../../engine/src/adapters/repair';
import { backupWorkerOf } from '../../../engine/src/adapters/site';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type {
	RepairCall,
	RepairDeps,
	RepairReading,
	RepairWorker
} from '../../../engine/src/ports';
import type { RepairRecord } from '../../../engine/src/repair/rows';
import {
	planSiteRepair,
	runSiteRepair,
	type RepairRegistries,
	type SiteRepairInput
} from '../../../engine/src/workflows/site-repair';
import { DEFAULT_REPAIR_BUDGET } from '../../../src/server/domain/incidents';
import { fakeBlobs } from './backup-fakes';
import { FAKE_OWNER_TOKEN, makeRunner, makeWorld, type Memo, type RunnerScript } from './fakes';

export const SITE_HOST = 'repair.drupflare.app';

// findings an /invalidate clears when it works
export const INVALIDATE_CLEARS = ['render.empty', 'render.size_anomaly', 'cache.anonymous_purity'];

// a site the repair routes act on: each route changes the state the next read reports
export function fakeRepairSite() {
	const state = {
		findings: new Set<string>(),
		owed: 0,
		quarantined: false,
		transactionDepth: 0 as number | undefined,
		shedding: false,
		queued: 0,
		generation: 5,
		// false makes every route answer 200 and change nothing
		fixes: true,
		calls: [] as RepairCall[],
		reads: 0
	};
	const worker: RepairWorker = {
		async observe(): Promise<RepairReading> {
			state.reads++;
			return {
				findings: [...state.findings],
				owed: state.owed,
				facts: {},
				transactionDepth: state.transactionDepth,
				shedding: state.shedding,
				quarantined: state.quarantined
			};
		},
		async call(_host, call) {
			state.calls.push(call);
			if (call.path === '/invalidate') {
				const before = state.generation;
				if (state.fixes) {
					state.generation++;
					for (const code of INVALIDATE_CLEARS) state.findings.delete(code);
				}
				return {
					status: 200,
					json: { ok: true, generationBefore: before, generationAfter: state.generation }
				};
			}
			if (call.path === '/armfill') {
				const queued = state.queued;
				if (state.fixes) state.queued = 0;
				return {
					status: 200,
					json: { ok: true, queued, armed: state.fixes && queued > 0 }
				};
			}
			if (call.path === '/reconcile') {
				if (state.fixes && state.owed > 0) {
					state.owed--;
					return { status: 200, json: { ran: { id: 'step' } } };
				}
				return { status: 200, json: { ran: null } };
			}
			return { status: 404, json: null };
		}
	};
	return { state, worker };
}

let counter = 0;
export const nextOperationId = () => `op_${'r'.repeat(25)}${(counter++ % 36).toString(36)}`;

export async function repairWorld(options: { ring?: boolean } = {}) {
	const world = await makeWorld();
	const db = (world.ledger as unknown as { db: D1Database }).db;
	const site = fakeRepairSite();
	const siteId = world.siteId;
	await world.store.activateSite(
		{
			id: siteId,
			organizationId: world.orgId,
			name: siteId,
			plane: 'managed',
			accountId: world.accountId,
			category: 'cms',
			config: 'managed'
		},
		world.clock.now()
	);
	world.sqlite
		.prepare('UPDATE sites SET primary_hostname = ?, state = ? WHERE id = ?')
		.run(SITE_HOST, 'active', siteId);
	await world.deps.custody.sealOwnerToken(siteId, FAKE_OWNER_TOKEN);
	const refuseFetch = (async () => new Response('no', { status: 500 })) as typeof fetch;
	const flags = { ring: options.ring ?? false };
	const deps: RepairDeps = {
		...world.deps,
		worker: backupWorkerOf(refuseFetch, 1_000),
		blobs: fakeBlobs().blobs,
		backups: new D1BackupLedger(db),
		sleep: async () => {},
		repair: site.worker,
		repairs: new D1RepairLedger(db),
		ringPromotion: async () => flags.ring,
		budget: DEFAULT_REPAIR_BUDGET
	};
	const setSwitch = (scope: string, scopeId: string, auto: boolean) =>
		world.sqlite
			.prepare(
				`INSERT OR REPLACE INTO ladder_switches (scope, scope_id, auto, updated_at, updated_by)
				VALUES (?, ?, ?, 0, 'test')`
			)
			.run(scope, scopeId, auto ? 1 : 0);
	const records = () =>
		world.sqlite.prepare('SELECT * FROM repairs ORDER BY created_at, id').all() as unknown as {
			id: string;
			repair_id: string;
			status: string;
			rung: string;
			observation_before: string;
			observation_after: string | null;
			undo_of: string | null;
			operation_id: string;
		}[];
	return { world, deps, site, flags, setSwitch, records, db, siteId };
}

export type Rw = Awaited<ReturnType<typeof repairWorld>>;

export const inputOf = (
	rw: Rw,
	repairId: string,
	patch: Partial<SiteRepairInput> = {}
): SiteRepairInput => ({
	operationId: nextOperationId(),
	orgId: rw.world.orgId,
	siteId: rw.siteId,
	accountId: rw.world.accountId,
	repairId,
	trigger: 'manual',
	rung: 'observe',
	undoOf: null,
	...patch
});

export async function runRepair(
	rw: Rw,
	input: SiteRepairInput,
	options: { registries?: RepairRegistries; script?: RunnerScript; memo?: Memo } = {}
) {
	const frozen = await freezePlan(planSiteRepair(input));
	const operation = newOperation({
		id: input.operationId,
		orgId: rw.world.orgId,
		idempotencyKey: `key-${input.operationId}`,
		frozen,
		now: rw.world.clock.now()
	});
	await rw.world.store.begin({
		operation,
		accountId: rw.world.accountId,
		siteId: input.siteId
	});
	const { runner, executed } = makeRunner(options.memo ?? new Map(), options.script);
	const outcome = await runSiteRepair(runner, rw.deps, input, options.registries);
	const stored = (await rw.world.store.get(input.operationId))!;
	return { outcome, executed, operation: stored };
}

export const parsed = (text: string | null) => JSON.parse(text ?? 'null') as Record<string, any>;

export type { RepairRecord };
