import type { Plan } from '@contracts/operations';
import type { AuthorityState } from '@contracts/site-auth';
import { buildPlan, setVerification, transition } from '../operations/state';
import type { EngineDeps } from '../ports';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import {
	closeFailed,
	describeFailure,
	finishSuccess,
	runStep,
	startOperation,
	type Ctx,
	type Outcome
} from './common';

export const SITE_AUTH_STATES = ['active', 'suspended'] as const;
export type SiteAuthStateWanted = (typeof SITE_AUTH_STATES)[number];

export interface SiteAuthStateInput {
	operationId: string;
	orgId: string;
	siteId: string;
	accountId: string;
	state: SiteAuthStateWanted;
	// who asked, and why, for the record
	actor: string;
	reason: 'abuse' | 'billing' | 'lift';
}

export function planSiteAuthState(input: Pick<SiteAuthStateInput, 'siteId' | 'state'>): Plan {
	const lifting = input.state === 'active';
	return buildPlan({
		type: 'config.apply',
		targetIds: [input.siteId],
		preconditions: [`${input.siteId} has an authority record`],
		steps: [
			{
				id: 'apply',
				name: lifting ? 'Lift the suspension' : 'Suspend the site'
			},
			{ id: 'mirror', name: 'Record the state on the site row' },
			{ id: 'confirm', name: 'Read the state back' }
		]
	});
}

// null when the site already holds the state. A revoked site never comes back, and only a
// suspension is lifted: an over-budget or grace state belongs to the budget writer
export function nextSiteAuthState(
	current: AuthorityState,
	wanted: SiteAuthStateWanted
): AuthorityState | null {
	if (current.state === 'revoked') {
		throw new PermanentError(
			'site_revoked',
			`${current.siteId} was revoked, so its state is fixed`
		);
	}
	if (wanted === 'suspended') {
		return current.state === 'suspended'
			? null
			: { ...current, state: 'suspended', generation: current.generation + 1 };
	}
	return current.state === 'suspended'
		? { ...current, state: 'active', generation: current.generation + 1 }
		: null;
}

const ATTEMPTS = 3;

// the next generation is read first, so a repeat writes nothing and a write that lost a race to
// another authority change reads again
export async function applySiteAuthState(
	deps: EngineDeps,
	siteId: string,
	wanted: SiteAuthStateWanted
): Promise<'written' | 'unchanged'> {
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const current = await deps.authority.read(siteId);
		if (current === null)
			throw new PermanentError('no_authority', `${siteId} has no authority record`);
		const next = nextSiteAuthState(current, wanted);
		if (next === null) return 'unchanged';
		try {
			await deps.authority.apply(next);
			return 'written';
		} catch (error) {
			if (error instanceof PermanentError && error.code === 'authority_stale_generation')
				continue;
			throw error;
		}
	}
	throw new PermanentError(
		'authority_stale_generation',
		'SITE_AUTH kept moving while the state was written'
	);
}

export async function runSiteAuthState(
	step: StepRunner,
	deps: EngineDeps,
	input: SiteAuthStateInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'config.apply',
		epoch: null
	};
	try {
		await startOperation(ctx);
		const written = await runStep(ctx, 'apply', 'apply', () =>
			applySiteAuthState(deps, input.siteId, input.state)
		);
		await runStep(ctx, 'mirror', 'mirror', async () => {
			const row = await deps.store.siteState(input.siteId);
			if (row !== 'active' && row !== 'suspended') return;
			await deps.store.setSiteState(input.siteId, input.state, deps.now());
		});
		await runStep(ctx, 'confirm', 'confirm', async () => {
			const after = await deps.authority.read(input.siteId);
			if (after?.state !== input.state) {
				throw new PermanentError(
					'state_not_held',
					`${input.siteId} reads ${after?.state ?? 'nothing'} after the write`
				);
			}
			await deps.store.mutate(input.operationId, (operation) =>
				operation.verification === 'passed'
					? operation
					: setVerification(
							operation.status === 'running'
								? transition(operation, 'verifying', deps.now())
								: operation,
							'passed',
							deps.now()
						)
			);
		});
		await finishSuccess(
			ctx,
			`${input.siteId} is ${input.state === 'suspended' ? 'suspended' : 'active again'} (${written})`
		);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const closed = await closeFailed(ctx, error);
		const reason = describeFailure(error);
		return closed === 'cancelled'
			? { status: 'cancelled', reason }
			: { status: 'failed', reason, leaked: [] };
	}
	return { status: 'succeeded' };
}
