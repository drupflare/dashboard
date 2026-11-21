import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSigningKey } from '../../../contracts/src/common';
import { issueLease, type AuthorityState } from '../../../contracts/src/site-auth';
import { signApply } from '../../../dispatch/src/authority';
import {
	AuthorityStale,
	budgetAuthorityOf,
	nextBudgetAuthority
} from '../../../engine/src/adapters/authority';
import { PermanentError } from '../../../engine/src/step';
import { authorityState } from '../dispatch/fakes';
import { siteAuthObjects } from './doubles';

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown
		) {}
	}
}));

const NOW = 1_790_000_000_000;

// the authority object checks the message time against its own clock
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function rig() {
	const control = await generateSigningKey();
	const objects = siteAuthObjects(control);
	const state = await authorityState({ epoch: 2, generation: 4 });
	const stub = objects.stub(state.siteId);
	await stub.apply(await signApply(state, NOW, control.privateKey));
	const applied: AuthorityState[] = [];
	const writer = budgetAuthorityOf({
		siteAuth: () => ({
			read: () => stub.read(),
			apply: async (message) => {
				const answer = await stub.apply(message);
				const {
					v: _v,
					iat: _iat,
					sig: _sig,
					...next
				} = message as AuthorityState & {
					v: number;
					iat: number;
					sig: string;
				};
				if (answer.ok && answer.value.applied) applied.push(next as AuthorityState);
				return answer;
			}
		}),
		controlKey: control.privateKey,
		now: () => NOW
	});
	return { control, stub, state, writer, applied };
}

describe('nextBudgetAuthority', () => {
	it('blocks with the next generation and keeps every other limit', async () => {
		const state = await authorityState({ generation: 4 });
		const next = nextBudgetAuthority(state, { state: 'over-budget', blockAtViews: null });
		expect(next).toMatchObject({ state: 'over-budget', generation: 5, epoch: state.epoch });
		expect(next?.limits).toEqual(state.limits);
	});

	it('writes the threshold as a whole number and removes it when none is wanted', async () => {
		const state = await authorityState();
		const set = nextBudgetAuthority(state, { state: 'ok', blockAtViews: 1500.7 });
		expect(set?.limits.blockAtViews).toBe(1500);
		expect(set?.state).toBe('active');
		const cleared = nextBudgetAuthority(set!, { state: 'ok', blockAtViews: null });
		expect('blockAtViews' in cleared!.limits).toBe(false);
		expect(cleared?.limits).toEqual(state.limits);
	});

	it('lifts a block back to active and leaves plan grace alone', async () => {
		const blocked = await authorityState({ state: 'over-budget' });
		expect(nextBudgetAuthority(blocked, { state: 'ok', blockAtViews: null })?.state).toBe(
			'active'
		);
		const grace = await authorityState({ state: 'plan-grace' });
		expect(nextBudgetAuthority(grace, { state: 'ok', blockAtViews: null })).toBeNull();
	});

	it('moves a site into plan grace when asked and stays there on a repeat', async () => {
		const state = await authorityState({ generation: 4 });
		const next = nextBudgetAuthority(state, { state: 'plan-grace', blockAtViews: null });
		expect(next).toMatchObject({ state: 'plan-grace', generation: 5 });
		expect(nextBudgetAuthority(next!, { state: 'plan-grace', blockAtViews: null })).toBeNull();
	});

	it('returns null when nothing would change', async () => {
		const state = await authorityState({ limits: { viewsPerMonth: 10, blockAtViews: 20 } });
		expect(nextBudgetAuthority(state, { state: 'ok', blockAtViews: 20 })).toBeNull();
		const blocked = await authorityState({ state: 'over-budget' });
		expect(
			nextBudgetAuthority(blocked, { state: 'over-budget', blockAtViews: null })
		).toBeNull();
	});
});

describe('applyBudgetState over a real authority object', () => {
	it('blocks, signs a lease that says so, and lifts it again', async () => {
		const r = await rig();
		const first = await r.writer.applyBudgetState(r.state.siteId, {
			state: 'over-budget',
			blockAtViews: null
		});
		expect(first).toEqual({ outcome: 'written', generation: 5 });
		const read = await r.stub.read();
		expect(read?.state).toBe('over-budget');
		const key = await generateSigningKey();
		const lease = await issueLease(read!, NOW, key.privateKey);
		expect(lease.state).toBe('over-budget');
		const lifted = await r.writer.applyBudgetState(r.state.siteId, {
			state: 'ok',
			blockAtViews: null
		});
		expect(lifted).toEqual({ outcome: 'written', generation: 6 });
		expect((await r.stub.read())?.state).toBe('active');
	});

	it('writes nothing for a repeat of the same answer', async () => {
		const r = await rig();
		const input = { state: 'over-budget', blockAtViews: null } as const;
		await r.writer.applyBudgetState(r.state.siteId, input);
		const again = await r.writer.applyBudgetState(r.state.siteId, input);
		expect(again).toEqual({ outcome: 'unchanged', generation: 5 });
		const withBlock = { state: 'ok', blockAtViews: 40 } as const;
		await r.writer.applyBudgetState(r.state.siteId, withBlock);
		await r.writer.applyBudgetState(r.state.siteId, withBlock);
		expect(r.applied).toHaveLength(2);
	});

	it('never replaces a security state or invents a site', async () => {
		const r = await rig();
		const suspended = { ...r.state, generation: 9, state: 'suspended' as const };
		await r.stub.apply(await signApply(suspended, NOW, r.control.privateKey));
		const refused = await r.writer.applyBudgetState(r.state.siteId, {
			state: 'over-budget',
			blockAtViews: null
		});
		expect(refused).toEqual({ outcome: 'security-state' });
		expect((await r.stub.read())?.state).toBe('suspended');
		const empty = budgetAuthorityOf({
			siteAuth: () => ({
				read: async () => null,
				apply: async () => ({ ok: false, code: 'x' })
			}),
			controlKey: r.control.privateKey,
			now: () => NOW
		});
		expect(
			await empty.applyBudgetState('site_ghost000001', { state: 'ok', blockAtViews: 1 })
		).toEqual({
			outcome: 'unknown-site'
		});
	});

	it('reads again and succeeds when an access change took the next generation first', async () => {
		const r = await rig();
		let raced = false;
		const racing = budgetAuthorityOf({
			siteAuth: () => ({
				read: () => r.stub.read(),
				apply: async (message) => {
					if (!raced) {
						raced = true;
						const other = { ...r.state, generation: 5 };
						await r.stub.apply(await signApply(other, NOW, r.control.privateKey));
					}
					return r.stub.apply(message);
				}
			}),
			controlKey: r.control.privateKey,
			now: () => NOW
		});
		const answer = await racing.applyBudgetState(r.state.siteId, {
			state: 'over-budget',
			blockAtViews: null
		});
		expect(answer).toEqual({ outcome: 'written', generation: 6 });
	});

	it('gives up with a typed error when the authority keeps moving', async () => {
		const stale = budgetAuthorityOf({
			siteAuth: () => ({
				read: async () => await authorityState(),
				apply: async () => ({ ok: false, code: 'stale_generation' })
			}),
			controlKey: (await generateSigningKey()).privateKey,
			now: () => NOW
		});
		const error = await stale
			.applyBudgetState('site_x', { state: 'over-budget', blockAtViews: null })
			.catch((e) => e);
		expect(error).toBeInstanceOf(PermanentError);
		expect(error.code).toBe('authority_stale_generation');
	});

	it('treats a stale message as retryable and any other refusal as permanent', async () => {
		const refusing = async (code: string) =>
			budgetAuthorityOf({
				siteAuth: () => ({
					read: async () => await authorityState(),
					apply: async () => ({ ok: false, code })
				}),
				controlKey: (await generateSigningKey()).privateKey,
				now: () => NOW
			}).applyBudgetState('site_x', { state: 'over-budget', blockAtViews: null });
		expect(await refusing('stale_message').catch((e) => e)).toBeInstanceOf(AuthorityStale);
		const bad = await refusing('bad_signature').catch((e) => e);
		expect(bad).toBeInstanceOf(PermanentError);
		expect(bad.code).toBe('authority_bad_signature');
	});
});
