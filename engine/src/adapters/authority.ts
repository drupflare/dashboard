import { canonicalJson } from '@contracts/common';
import { BLOCK_AT_VIEWS, isSecurityState, type AuthorityState } from '@contracts/site-auth';
import { signApply } from '../../../dispatch/src/authority';
import type { Authority } from '../ports';
import { PermanentError } from '../step';
import type { Hosts } from './hosts';

export type ApplyAnswer =
	{ ok: true; value: { applied: boolean; generation: number } } | { ok: false; code: string };

export interface SiteAuthStub {
	read(): Promise<AuthorityState | null>;
	apply(message: unknown): Promise<ApplyAnswer>;
}

// the message carries a time, so the step is retried and signs a fresh one
export class AuthorityStale extends Error {
	constructor() {
		super('SITE_AUTH found the message stale');
		this.name = 'AuthorityStale';
	}
}

// a rise in epoch refuses every lease minted under the old one; the generation rises with it so the apply is not stale
export async function bumpEpoch(
	authority: Authority,
	siteId: string
): Promise<{ epoch: number; generation: number }> {
	const current = await authority.read(siteId);
	if (current === null)
		throw new PermanentError('no_authority', `${siteId} has no authority record`);
	const next = { ...current, epoch: current.epoch + 1, generation: current.generation + 1 };
	await authority.apply(next);
	return { epoch: next.epoch, generation: next.generation };
}

export function authorityOf(options: {
	siteAuth: (siteId: string) => SiteAuthStub;
	hosts: Hosts;
	controlKey: CryptoKey;
	now: () => number;
}): Authority {
	return {
		read: (siteId) => options.siteAuth(siteId).read(),
		async apply(state) {
			const message = await signApply(state, options.now(), options.controlKey);
			const answer = await options.siteAuth(state.siteId).apply(message);
			if (answer.ok) return answer.value;
			if (answer.code === 'stale_message') throw new AuthorityStale();
			throw new PermanentError(
				`authority_${answer.code}`,
				`SITE_AUTH refused the write: ${answer.code}`
			);
		},
		putHost: options.hosts.put,
		deleteHostIfOwned: options.hosts.deleteIfOwned
	};
}

// #region budget state

export type BudgetStateInput = {
	state: 'ok' | 'over-budget' | 'plan-grace';
	blockAtViews: number | null;
};

export type BudgetWrite =
	| { outcome: 'written'; generation: number }
	| { outcome: 'unchanged'; generation: number }
	| { outcome: 'security-state' | 'unknown-site' };

// null when nothing changes. A block is lifted back to active; plan grace and the security states
// are never replaced by a budget answer, and a lifted block leaves no threshold behind
export function nextBudgetAuthority(
	current: AuthorityState,
	input: BudgetStateInput
): AuthorityState | null {
	const { [BLOCK_AT_VIEWS]: _old, ...limits } = current.limits;
	if (input.blockAtViews !== null) {
		limits[BLOCK_AT_VIEWS] = Math.max(0, Math.floor(input.blockAtViews));
	}
	let state = current.state;
	if (input.state === 'over-budget' || input.state === 'plan-grace') state = input.state;
	else if (current.state === 'over-budget') state = 'active';
	const next = { ...current, state, limits };
	if (canonicalJson(next) === canonicalJson(current)) return null;
	return { ...next, generation: current.generation + 1 };
}

const BUDGET_ATTEMPTS = 3;

// the next generation is read first, so a repeat of the same answer writes nothing, and a write
// that lost a race to an access change reads again and tries the newer authority
export function budgetAuthorityOf(options: {
	siteAuth: (siteId: string) => SiteAuthStub;
	controlKey: CryptoKey;
	now: () => number;
}): { applyBudgetState(siteId: string, input: BudgetStateInput): Promise<BudgetWrite> } {
	return {
		async applyBudgetState(siteId, input) {
			const stub = options.siteAuth(siteId);
			for (let attempt = 0; attempt < BUDGET_ATTEMPTS; attempt++) {
				const current = await stub.read();
				if (current === null) return { outcome: 'unknown-site' };
				if (isSecurityState(current.state)) return { outcome: 'security-state' };
				const next = nextBudgetAuthority(current, input);
				if (next === null) return { outcome: 'unchanged', generation: current.generation };
				const message = await signApply(next, options.now(), options.controlKey);
				const answer = await stub.apply(message);
				if (answer.ok) return { outcome: 'written', generation: answer.value.generation };
				if (answer.code === 'stale_generation') continue;
				if (answer.code === 'stale_message') throw new AuthorityStale();
				throw new PermanentError(
					`authority_${answer.code}`,
					`SITE_AUTH refused the write: ${answer.code}`
				);
			}
			throw new PermanentError(
				'authority_stale_generation',
				'SITE_AUTH kept moving while the budget state was written'
			);
		}
	};
}

// #endregion
