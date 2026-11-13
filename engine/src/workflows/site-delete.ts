import type { Plan } from '@contracts/operations';
import type { SitePlane } from '@contracts/sites';
import { buildPlan, observe, transition } from '../operations/state';
import type { SiteRowState } from '../operations/store';
import { purgeRows, purgeScript } from '../ownership';
import type { DomainDeps, EngineDeps } from '../ports';
import { StepFailed, type StepRunner } from '../step';
import {
	acquireLease,
	closeFailed,
	describeFailure,
	fenced,
	finishSuccess,
	plainStep,
	releaseLease,
	runStep,
	startOperation,
	type Ctx,
	type Outcome
} from './common';
import { releaseSiteDomains } from './domain-attach';

// a deploy that builds the domain ports lets a delete release the site's custom hostnames too
export type DomainReleaseDeps = EngineDeps & Partial<Pick<DomainDeps, 'hostnames' | 'domains'>>;

export interface SiteDeleteInput {
	operationId: string;
	siteId: string;
	accountId: string;
	hostnames: string[];
}

export interface SitePurgeInput {
	operationId: string;
	siteId: string;
	accountId: string;
	// absent means self-managed, the strict reading: only what the ledger names is deleted
	plane?: SitePlane;
	subdomain: string;
	confirm: string;
	holdUntil: number;
}

export const PURGE_REFUSALS = ['not_tombstoned', 'confirmation_required', 'hold_active'] as const;
export type PurgeRefusal = (typeof PURGE_REFUSALS)[number];

export function checkPurge(input: {
	state: SiteRowState | null;
	siteId: string;
	confirm: string;
	holdUntil: number;
	now: number;
}): PurgeRefusal | null {
	if (input.state !== 'tombstoned' && input.state !== 'purge-eligible') return 'not_tombstoned';
	if (input.confirm !== input.siteId) return 'confirmation_required';
	if (input.now < input.holdUntil) return 'hold_active';
	return null;
}

export function planSiteDelete(input: Pick<SiteDeleteInput, 'siteId'>): Plan {
	return buildPlan({
		type: 'site.delete',
		targetIds: [input.siteId],
		preconditions: [`${input.siteId} is active or suspended`],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'revoke', name: 'Revoke site authority' },
			{ id: 'route', name: 'Drop the hostname routes' },
			{ id: 'tombstone', name: 'Tombstone the site' }
		]
	});
}

export function planSitePurge(input: Pick<SitePurgeInput, 'siteId'>): Plan {
	return buildPlan({
		type: 'site.purge',
		targetIds: [input.siteId],
		preconditions: [`${input.siteId} is tombstoned and its hold has passed`],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'script', name: 'Delete the script' },
			{ id: 'resources', name: 'Delete the site resources' },
			{ id: 'name', name: 'Release the name' },
			{ id: 'forget', name: 'Mark the site deleted' }
		]
	});
}

async function releaseDomains(deps: DomainReleaseDeps, siteId: string) {
	if (deps.hostnames === undefined || deps.domains === undefined) {
		return { released: [], failed: [] };
	}
	return releaseSiteDomains(
		{ authority: deps.authority, hostnames: deps.hostnames, domains: deps.domains },
		siteId
	);
}

function context(
	step: StepRunner,
	deps: EngineDeps,
	input: { operationId: string; siteId: string; accountId: string },
	purpose: string
): Ctx {
	return {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose,
		epoch: null
	};
}

// neither of these rolls back: a half-done delete is finished by running it again, since
// authority is revoked before anything else is touched
async function failForward(ctx: Ctx, failure: StepFailed): Promise<Outcome> {
	const closed = await closeFailed(ctx, failure);
	const reason = describeFailure(failure);
	await releaseLease(ctx);
	return closed === 'cancelled'
		? { status: 'cancelled', reason }
		: { status: 'failed', reason, leaked: [] };
}

export async function runSiteDelete(
	step: StepRunner,
	deps: DomainReleaseDeps,
	input: SiteDeleteInput
): Promise<Outcome> {
	const ctx = context(step, deps, input, 'site.delete');
	let notes = '';
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		await runStep(ctx, 'revoke', 'revoke', async () => {
			await fenced(ctx);
			const current = await deps.authority.read(input.siteId);
			if (current === null || current.state === 'revoked') return;
			await deps.authority.apply({
				...current,
				state: 'revoked',
				generation: current.generation + 1
			});
		});
		// a hostname that now names another site is left in place and reported
		const foreign = await runStep(ctx, 'route', 'route', async () => {
			await fenced(ctx);
			const left: string[] = [];
			for (const hostname of input.hostnames) {
				const answer = await deps.authority.deleteHostIfOwned(hostname, input.siteId);
				if (answer === 'foreign') left.push(hostname);
			}
			const domains = await releaseDomains(deps, input.siteId);
			return { left, kept: domains.failed };
		});
		await runStep(ctx, 'tombstone', 'tombstone', async () => {
			await fenced(ctx);
			await deps.custody.discardPending(input.siteId);
			await deps.store.setSiteState(input.siteId, 'tombstoned', deps.now());
		});
		notes =
			(foreign.left.length === 0
				? ''
				: `; left in place, held by another site: ${foreign.left.join(', ')}`) +
			(foreign.kept.length === 0
				? ''
				: `; custom domains the provider would not release: ${foreign.kept.join(', ')}`);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return failForward(ctx, error);
	}
	await finishSuccess(
		ctx,
		`${input.siteId} is tombstoned; its resources are kept for the hold${notes}`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}

export async function runSitePurge(
	step: StepRunner,
	deps: DomainReleaseDeps,
	input: SitePurgeInput
): Promise<Outcome> {
	const ctx = context(step, deps, input, 'site.purge');
	const refusal = await plainStep(ctx, 'guard', async () =>
		checkPurge({
			state: await deps.store.siteState(input.siteId),
			siteId: input.siteId,
			confirm: input.confirm,
			holdUntil: input.holdUntil,
			now: deps.now()
		})
	);
	if (refusal !== null) {
		// nothing was touched; the operation is cancelled so it does not look pending
		await plainStep(ctx, 'refuse', async () => {
			await deps.store.mutate(input.operationId, (operation) =>
				operation.status === 'cancelled'
					? operation
					: transition(
							observe(operation, `purge refused: ${refusal}`, deps.now()),
							'cancelled',
							deps.now()
						)
			);
		});
		return { status: 'cancelled', reason: refusal };
	}
	let kept: string[] = [];
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		const claim = {
			siteId: input.siteId,
			accountId: input.accountId,
			plane: input.plane ?? 'self-managed'
		};
		kept = await runStep(ctx, 'script', 'script', async () => {
			await fenced(ctx);
			await purgeRows(deps, claim, ['route']);
			const domains = await releaseDomains(deps, input.siteId);
			await purgeScript(deps, claim);
			return domains.failed;
		});
		await runStep(ctx, 'resources', 'resources', async () => {
			await fenced(ctx);
			await purgeRows(deps, claim, ['kv', 'r2', 'd1']);
		});
		await runStep(ctx, 'name', 'name', async () => {
			await fenced(ctx);
			await deps.names.release(input.subdomain, input.siteId);
		});
		await runStep(ctx, 'forget', 'forget', async () => {
			await fenced(ctx);
			await deps.custody.discard(input.siteId);
			await deps.store.setSiteState(input.siteId, 'deleted', deps.now());
		});
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return failForward(ctx, error);
	}
	await finishSuccess(
		ctx,
		`${input.siteId} was purged${kept.length === 0 ? '' : `; custom domains the provider would not release: ${kept.join(', ')}`}`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
