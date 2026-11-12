import type { Plan } from '@contracts/operations';
import type { SitePlane } from '@contracts/sites';
import { buildPlan, observe, transition } from '../operations/state';
import { rollbackRow, type LedgerRow } from '../ownership';
import type { EngineDeps } from '../ports';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import {
	acquireLease,
	closeFailed,
	describeFailure,
	fenced,
	finishSuccess,
	LeaseLostError,
	plainStep,
	releaseLease,
	runStep,
	SiteBusyError,
	startOperation,
	type Ctx,
	type Outcome
} from './common';

export interface CleanupTarget {
	siteId: string;
	accountId: string;
	plane: SitePlane;
	hostname: string;
	subdomain: string;
}

export interface SiteCleanupInput extends CleanupTarget {
	operationId: string;
}

export class SiteActiveError extends PermanentError {
	constructor(siteId: string) {
		super('site_active', `${siteId} became active, so it is not cleaned up`);
	}
}

type Action = (deps: EngineDeps, target: CleanupTarget) => Promise<string | void>;

// each action only touches what this site's own ledger or route names, and is safe to repeat
async function dropRows(
	deps: EngineDeps,
	target: CleanupTarget,
	match: (row: LedgerRow) => boolean
): Promise<void> {
	const rows = (await deps.ledger.live(target.siteId)).filter(match);
	for (const row of [...rows].reverse()) {
		const claim = {
			siteId: target.siteId,
			accountId: row.accountId,
			plane: target.plane,
			operationId: row.createdByOperation
		};
		await rollbackRow(deps, claim, (candidate) => candidate.id === row.id);
	}
}

const stopServing: Action = async (deps, target) => {
	const answer = await deps.authority.deleteHostIfOwned(target.hostname, target.siteId);
	const current = await deps.authority.read(target.siteId);
	if (current !== null && current.state !== 'revoked') {
		await deps.authority.apply({
			...current,
			state: 'revoked',
			generation: current.generation + 1
		});
	}
	if (answer === 'foreign') {
		return `route for ${target.hostname} belongs to another site and was left in place`;
	}
};

const dropScript: Action = (deps, target) =>
	dropRows(deps, target, (row) => row.kind === 'route' || row.kind === 'script');

const dropResources: Action = (deps, target) => dropRows(deps, target, () => true);

const releaseName: Action = async (deps, target) => {
	await deps.names.release(target.subdomain, target.siteId, 0);
};

// last, so a cleanup that stopped early still leaves a row the next run and the sweep find
const forgetSite: Action = async (deps, target) => {
	await deps.custody.discard(target.siteId);
	if ((await deps.store.siteState(target.siteId)) !== null) {
		await deps.store.setSiteState(target.siteId, 'deleted', deps.now());
	}
};

const ACTIONS: readonly (readonly [id: string, action: Action])[] = [
	['stop', stopServing],
	['script', dropScript],
	['resources', dropResources],
	['name', releaseName],
	['forget', forgetSite]
];

export function planSiteCleanup(input: Pick<SiteCleanupInput, 'siteId'>): Plan {
	return buildPlan({
		type: 'repair.run',
		targetIds: [input.siteId],
		preconditions: [`${input.siteId} never became active`],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'stop', name: 'Stop the site serving' },
			{ id: 'script', name: 'Delete the script and routes' },
			{ id: 'resources', name: 'Delete the site resources' },
			{ id: 'name', name: 'Release the name' },
			{ id: 'forget', name: 'Mark the site deleted' }
		]
	});
}

export const CLEANUP_STEP = { id: 'cleanup', name: 'Clean up the earlier attempt' } as const;

// the first leg of a retried create: the earlier site's writer lease is held by this operation for
// the length of the step and is not the lease the operation's own record is fenced to
export async function cleanPrior(ctx: Ctx, prior: CleanupTarget): Promise<void> {
	await runStep(ctx, CLEANUP_STEP.id, CLEANUP_STEP.id, () =>
		cleanTarget(ctx.deps, ctx.operationId, ctx.purpose, prior)
	);
}

// every action of a cleanup under a lease on the target that the holder takes and gives back; a
// site that already went live is refused
export async function cleanTarget(
	deps: EngineDeps,
	holder: string,
	purpose: string,
	target: CleanupTarget
): Promise<void> {
	if (await deps.store.siteLive(target.siteId)) throw new SiteActiveError(target.siteId);
	const granted = await deps.leases.acquire(target.siteId, {
		holder,
		purpose,
		ttlMs: deps.config.leaseTtlMs
	});
	if (!granted.ok) throw new SiteBusyError(target.siteId, granted.heldBy);
	try {
		for (const [, action] of ACTIONS) {
			const verdict = await deps.leases.heartbeat(target.siteId, {
				holder,
				epoch: granted.epoch,
				ttlMs: deps.config.leaseTtlMs
			});
			if (!verdict.ok) throw new LeaseLostError(target.siteId, verdict.code);
			await action(deps, target);
		}
	} finally {
		await deps.leases
			.release(target.siteId, { holder, epoch: granted.epoch })
			.catch(() => undefined);
	}
}

// a half-done cleanup is finished by running it again, so a failure closes the operation as it is
export async function runSiteCleanup(
	step: StepRunner,
	deps: EngineDeps,
	input: SiteCleanupInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'repair.run',
		epoch: null
	};
	const refused = await plainStep(ctx, 'guard', () => deps.store.siteLive(input.siteId));
	if (refused) {
		await plainStep(ctx, 'refuse', async () => {
			await deps.store.mutate(input.operationId, (operation) =>
				operation.status === 'cancelled'
					? operation
					: transition(
							observe(operation, 'cleanup refused: site_active', deps.now()),
							'cancelled',
							deps.now()
						)
			);
		});
		return { status: 'cancelled', reason: 'site_active' };
	}
	const notes: string[] = [];
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		for (const [id, action] of ACTIONS) {
			const note = await runStep(ctx, id, id, async () => {
				await fenced(ctx);
				return (await action(deps, input)) ?? null;
			});
			if (note !== null) notes.push(note);
		}
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const closed = await closeFailed(ctx, error);
		const reason = describeFailure(error);
		await releaseLease(ctx);
		return closed === 'cancelled'
			? { status: 'cancelled', reason }
			: { status: 'failed', reason, leaked: [] };
	}
	const left = notes.length === 0 ? '' : `; ${notes.join('; ')}`;
	await finishSuccess(ctx, `${input.siteId} was cleaned up${left}`);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
