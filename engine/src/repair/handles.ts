import { CATALOGUE_ROWS, type CatalogueRow } from '../../../src/shared/health/catalogue';
import type { OwnerAuth, RepairWorker } from '../ports';
import { PermanentError } from '../step';

export const REPAIR_REFUSALS = [
	'uncatalogued',
	'no_handler',
	'no_route',
	'auto_off',
	'quarantined',
	'precondition',
	'attempts',
	'cooling_down',
	'budget',
	'not_undoable',
	'not_cleared'
] as const;
export type RepairRefusal = (typeof REPAIR_REFUSALS)[number];

export class RepairRefused extends PermanentError {
	declare readonly code: RepairRefusal;

	constructor(code: RepairRefusal, message: string) {
		super(code, message);
	}
}

export interface RepairRun {
	ok: boolean;
	detail: string;
	// answers the call itself gave about the repair, merged into the observation after it
	facts?: Record<string, boolean>;
}

export type RepairExecutor = (
	worker: RepairWorker,
	hostname: string,
	auth: OwnerAuth
) => Promise<RepairRun>;

export interface RepairHandler {
	// false when the worker has no owner route for the handle the row names
	verified: boolean;
	run: RepairExecutor;
}

export const RECONCILE_STEP_LIMIT = 20;

const isSuccess = (status: number) => status >= 200 && status < 300;

const body = (json: unknown): Record<string, unknown> =>
	typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};

const invalidate: RepairExecutor = async (worker, hostname, auth) => {
	const answer = await worker.call(hostname, { method: 'GET', path: '/invalidate' }, auth);
	const { generationBefore, generationAfter } = body(answer.json);
	const bumped =
		typeof generationBefore === 'number' &&
		typeof generationAfter === 'number' &&
		generationAfter > generationBefore;
	return {
		ok: isSuccess(answer.status),
		detail: `/invalidate answered ${answer.status}`,
		facts: { 'cache.stale_paths_cleared': bumped }
	};
};

const armfill: RepairExecutor = async (worker, hostname, auth) => {
	const answer = await worker.call(hostname, { method: 'GET', path: '/armfill' }, auth);
	const { queued, armed } = body(answer.json);
	return {
		ok: isSuccess(answer.status),
		detail: `/armfill answered ${answer.status}`,
		facts: { 'fill.gap_closed': queued === 0 || armed === true }
	};
};

// one POST pays one step; the site answers ran: null once nothing is left to run
const reconcile: RepairExecutor = async (worker, hostname, auth) => {
	for (let step = 0; step < RECONCILE_STEP_LIMIT; step++) {
		const answer = await worker.call(hostname, { method: 'POST', path: '/reconcile' }, auth);
		if (!isSuccess(answer.status)) {
			return { ok: false, detail: `/reconcile answered ${answer.status}` };
		}
		if ((body(answer.json).ran ?? null) === null) {
			return { ok: true, detail: `/reconcile ran ${step} steps` };
		}
	}
	return { ok: true, detail: `/reconcile ran ${RECONCILE_STEP_LIMIT} steps and may owe more` };
};

// recycled is false when no interpreter was resident, which already means a clean heap
const recycle: RepairExecutor = async (worker, hostname, auth) => {
	const answer = await worker.call(hostname, { method: 'POST', path: '/recycle' }, auth);
	return {
		ok: isSuccess(answer.status),
		detail:
			body(answer.json).recycled === false
				? '/recycle found no interpreter resident'
				: `/recycle answered ${answer.status}`
	};
};

const ledgerGc: RepairExecutor = async (worker, hostname, auth) => {
	const answer = await worker.call(hostname, { method: 'POST', path: '/ledger-gc' }, auth);
	const { rowsDeleted } = body(answer.json);
	return {
		ok: isSuccess(answer.status),
		detail:
			typeof rowsDeleted === 'number'
				? `/ledger-gc deleted ${rowsDeleted} rows`
				: `/ledger-gc answered ${answer.status}`
	};
};

// the handles whose route the worker serves; the owner routes are in worker/src/site/routes.ts
export const EXECUTORS: Readonly<Record<string, RepairExecutor>> = {
	'/invalidate': invalidate,
	'/armfill': armfill,
	'/recycle': recycle,
	'/ledger-gc': ledgerGc,
	reconcile
};

const noRoute: RepairExecutor = async () => ({
	ok: false,
	detail: 'the site has no owner route for this repair'
});

export const isAutomatic = (row: CatalogueRow) =>
	row.automation === 'auto' || row.automation === 'auto-with-guard';

// approval and manual rows have no entry, so the workflow refuses them
export const REPAIR_HANDLES: Readonly<Record<string, RepairHandler>> = Object.fromEntries(
	CATALOGUE_ROWS.filter(isAutomatic).map((row) => {
		const run = EXECUTORS[row.handle];
		return [row.repairId, run ? { verified: true, run } : { verified: false, run: noRoute }];
	})
);

// keyed by the undo handle a row names; no automatic row names one today
export const UNDO_HANDLES: Readonly<Record<string, RepairExecutor>> = {};

export function repairHandle(
	repairId: string,
	registry: Readonly<Record<string, RepairHandler>> = REPAIR_HANDLES
): RepairHandler {
	const handler = registry[repairId];
	if (!handler) {
		throw new RepairRefused('no_handler', `repair ${repairId} has no automatic handler`);
	}
	return handler;
}
