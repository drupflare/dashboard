import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSigningKey } from '../../../contracts/src/common';
import { signApply } from '../../../dispatch/src/authority';
import { DEFAULT_HOLD_MS, MAX_HOLD_MS } from '../../../dispatch/src/registry';
import { shardKey } from '../../../src/shared/names';
import { namesObjects, siteAuthObjects } from '../engine/doubles';
import { authorityState } from './fakes';

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown
		) {}
	}
}));

const NOW = 1_790_000_000_000;
const A = 'site_aaaaaaaa0001';
const B = 'site_bbbbbbbb0002';
const NAME = 'calm-river-stone';

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('the Names object', () => {
	it('holds a released name for the default hold when no hold is given', async () => {
		const names = namesObjects();
		const shard = names.stub(shardKey(NAME));
		expect(await shard.reserve(NAME, A)).toBe('reserved');
		expect(await shard.release(NAME, A)).toBe('released');
		expect(await shard.reserve(NAME, B)).toBe('held');
		vi.setSystemTime(NOW + DEFAULT_HOLD_MS);
		expect(await shard.reserve(NAME, B)).toBe('reserved');
	});

	it('frees a name at once for a hold of zero and caps a hold above the maximum', async () => {
		const names = namesObjects();
		const shard = names.stub(shardKey(NAME));
		await shard.reserve(NAME, A);
		expect(await shard.release(NAME, A, 0)).toBe('released');
		expect(await shard.reserve(NAME, B)).toBe('reserved');
		await shard.release(NAME, B, MAX_HOLD_MS * 4);
		vi.setSystemTime(NOW + MAX_HOLD_MS - 1);
		expect(await shard.reserve(NAME, A)).toBe('held');
		vi.setSystemTime(NOW + MAX_HOLD_MS);
		expect(await shard.reserve(NAME, A)).toBe('reserved');
	});

	it('refuses a name sent to a shard that does not own it', async () => {
		const names = namesObjects();
		const wrong = shardKey(NAME) === 'shard-0' ? 'shard-1' : 'shard-0';
		expect(await names.stub(wrong).reserve(NAME, A)).toBe('invalid');
	});
});

describe('the SiteAuth object', () => {
	it('reads null for an unknown site and the stored state after a write', async () => {
		const control = await generateSigningKey();
		const objects = siteAuthObjects(control);
		const state = await authorityState({ siteId: A as never });
		expect(await objects.stub(A).read()).toBeNull();
		const message = await signApply(state, NOW, control.privateKey);
		expect(await objects.stub(A).apply(message)).toEqual({
			ok: true,
			value: { applied: true, generation: 1 }
		});
		expect(await objects.stub(A).read()).toEqual(state);
	});

	it('reads the stored generation after a restart, so the next write never reuses it', async () => {
		const control = await generateSigningKey();
		const objects = siteAuthObjects(control);
		const state = await authorityState({ siteId: A as never });
		await objects.stub(A).apply(await signApply(state, NOW, control.privateKey));
		const stored = await objects.stub(A).read();
		expect(stored?.generation).toBe(1);
		const revoke = {
			...stored!,
			state: 'revoked' as const,
			generation: stored!.generation + 1
		};
		expect(
			await objects.stub(A).apply(await signApply(revoke, NOW, control.privateKey))
		).toEqual({
			ok: true,
			value: { applied: true, generation: 2 }
		});
		const reused = { ...revoke, state: 'active' as const };
		expect(
			await objects.stub(A).apply(await signApply(reused, NOW, control.privateKey))
		).toEqual({
			ok: false,
			code: 'stale_generation'
		});
		const lower = { ...state, state: 'suspended' as const };
		expect(
			await objects.stub(A).apply(await signApply(lower, NOW, control.privateKey))
		).toEqual({
			ok: false,
			code: 'stale_generation'
		});
		expect((await objects.stub(A).read())?.state).toBe('revoked');
	});

	it('refuses a write for another site and a write signed with another key', async () => {
		const control = await generateSigningKey();
		const other = await generateSigningKey();
		const objects = siteAuthObjects(control);
		const state = await authorityState({ siteId: A as never });
		expect(
			await objects.stub(B).apply(await signApply(state, NOW, control.privateKey))
		).toEqual({
			ok: false,
			code: 'wrong_site'
		});
		expect(await objects.stub(A).apply(await signApply(state, NOW, other.privateKey))).toEqual({
			ok: false,
			code: 'bad_signature'
		});
		expect(await objects.stub(A).read()).toBeNull();
	});

	it('issues a lease for a stored site and refuses an unknown one', async () => {
		const control = await generateSigningKey();
		const objects = siteAuthObjects(control);
		const state = await authorityState({ siteId: A as never });
		const stub = objects.stub(A) as unknown as {
			lease(request: { siteId: string; epoch: number }): Promise<{ ok: boolean }>;
		};
		expect(await stub.lease({ siteId: A, epoch: 1 })).toMatchObject({
			ok: false,
			code: 'unknown_site'
		});
		await objects.stub(A).apply(await signApply(state, NOW, control.privateKey));
		expect(await stub.lease({ siteId: A, epoch: 1 })).toMatchObject({ ok: true });
	});
});
