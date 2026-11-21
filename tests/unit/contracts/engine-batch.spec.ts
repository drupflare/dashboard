import { describe, expect, it } from 'vitest';
import {
	BATCH_MAX_BYTES,
	BATCH_MAX_SITES,
	BATCH_REFUSALS,
	BATCH_REFUSAL_STATUS,
	BATCH_WINDOW_MS,
	BUDGET_WRITE_STATES,
	batchSecretsOf,
	signBatch,
	verifyBatch,
	type BatchKind
} from '../../../contracts/src/engine-batch';
import { START_HEADERS } from '../../../contracts/src/engine-start';

const NOW = 1_790_000_000_000;
const ID = 'req_vector_0001';
const BUDGET_SECRET = 'budget-secret-'.repeat(3);
const COUNTS_SECRET = 'counts-secret-'.repeat(3);
const START = 'start-secret-'.repeat(3);
const BUDGET_BODY = JSON.stringify({
	writes: [{ siteId: 'site_a', state: 'over-budget', blockAtViews: null }]
});
const COUNTS_BODY = JSON.stringify({
	reads: [{ siteId: 'site_a', hours: [NOW], months: ['2026-11'] }]
});

const headersOf = (signed: Record<string, string>) => new Headers(signed);

async function verdict(
	kind: BatchKind,
	body: string,
	options: { secret?: string; now?: number; sign?: Partial<{ now: number; id: string }> } = {}
) {
	const secret = kind === 'budget' ? BUDGET_SECRET : COUNTS_SECRET;
	const signed = await signBatch(kind, body, {
		secret,
		now: options.sign?.now ?? NOW,
		id: options.sign?.id ?? ID
	});
	return verifyBatch(kind, headersOf(signed), body, {
		secret: options.secret ?? secret,
		now: options.now ?? NOW
	});
}

describe('the signed vectors', () => {
	it('signs a budget write to the pinned value', async () => {
		const signed = await signBatch('budget', BUDGET_BODY, {
			secret: BUDGET_SECRET,
			now: NOW,
			id: ID
		});
		expect(signed[START_HEADERS.signature]).toBe(
			'2321ae93623cff598245a3827466653a0c7b5abd8aca3c5d2c342ac5d59dc26f'
		);
		expect(signed[START_HEADERS.timestamp]).toBe(String(NOW));
		expect(signed[START_HEADERS.id]).toBe(ID);
	});

	it('signs the same body differently as a counts read', async () => {
		const signed = await signBatch('counts', BUDGET_BODY, {
			secret: BUDGET_SECRET,
			now: NOW,
			id: ID
		});
		expect(signed[START_HEADERS.signature]).toBe(
			'40d821148d08dc9085a00c188bd5798c393913615acfc68cb46c93328726eb5c'
		);
	});
});

describe('verifyBatch', () => {
	it('accepts a signed write and a signed read, and returns the id and the items', async () => {
		expect(await verdict('budget', BUDGET_BODY)).toEqual({
			ok: true,
			id: ID,
			value: { writes: [{ siteId: 'site_a', state: 'over-budget', blockAtViews: null }] }
		});
		expect(await verdict('counts', COUNTS_BODY)).toMatchObject({ ok: true, id: ID });
	});

	it('refuses a request that is not signed with the secret of its own type', async () => {
		expect(await verdict('budget', BUDGET_BODY, { secret: COUNTS_SECRET })).toMatchObject({
			code: 'bad_signature'
		});
		expect(await verdict('counts', COUNTS_BODY, { secret: BUDGET_SECRET })).toMatchObject({
			code: 'bad_signature'
		});
	});

	it('refuses a signature made for the other message type, even under one secret', async () => {
		const signed = await signBatch('counts', BUDGET_BODY, {
			secret: BUDGET_SECRET,
			now: NOW,
			id: ID
		});
		expect(
			await verifyBatch('budget', headersOf(signed), BUDGET_BODY, {
				secret: BUDGET_SECRET,
				now: NOW
			})
		).toEqual({ ok: false, code: 'bad_signature' });
	});

	it('refuses a request outside the window and accepts the edge of it', async () => {
		expect(await verdict('budget', BUDGET_BODY, { now: NOW + BATCH_WINDOW_MS })).toMatchObject({
			ok: true
		});
		expect(await verdict('budget', BUDGET_BODY, { now: NOW + BATCH_WINDOW_MS + 1 })).toEqual({
			ok: false,
			code: 'stale'
		});
		expect(await verdict('counts', COUNTS_BODY, { now: NOW - BATCH_WINDOW_MS - 1 })).toEqual({
			ok: false,
			code: 'stale'
		});
	});

	it('refuses a missing header, an altered body and a swapped id', async () => {
		const signed = await signBatch('budget', BUDGET_BODY, {
			secret: BUDGET_SECRET,
			now: NOW,
			id: ID
		});
		const without = headersOf(signed);
		without.delete(START_HEADERS.signature);
		expect(
			await verifyBatch('budget', without, BUDGET_BODY, { secret: BUDGET_SECRET, now: NOW })
		).toEqual({ ok: false, code: 'unsigned' });
		expect(
			await verifyBatch(
				'budget',
				headersOf(signed),
				BUDGET_BODY.replace('site_a', 'site_b'),
				{
					secret: BUDGET_SECRET,
					now: NOW
				}
			)
		).toEqual({ ok: false, code: 'bad_signature' });
		const swapped = headersOf(signed);
		swapped.set(START_HEADERS.id, 'req_vector_0002');
		expect(
			await verifyBatch('budget', swapped, BUDGET_BODY, { secret: BUDGET_SECRET, now: NOW })
		).toEqual({ ok: false, code: 'bad_signature' });
	});

	it('refuses every state a budget may not write', async () => {
		for (const state of ['suspended', 'revoked', 'ok', 'anything']) {
			const body = JSON.stringify({ writes: [{ siteId: 's', state, blockAtViews: null }] });
			expect(await verdict('budget', body)).toEqual({ ok: false, code: 'malformed' });
		}
		for (const state of BUDGET_WRITE_STATES) {
			const body = JSON.stringify({ writes: [{ siteId: 's', state, blockAtViews: 5 }] });
			expect(await verdict('budget', body)).toMatchObject({ ok: true });
		}
	});

	it('refuses extra fields, a negative threshold and a repeated site', async () => {
		const write = { siteId: 's', state: 'active', blockAtViews: null };
		for (const body of [
			{ writes: [{ ...write, extra: 1 }] },
			{ writes: [{ ...write, blockAtViews: -1 }] },
			{ writes: [{ ...write, blockAtViews: 1.5 }] },
			{ writes: [write, write] },
			{ writes: [] },
			{ writes: [write], more: true }
		]) {
			expect(await verdict('budget', JSON.stringify(body))).toEqual({
				ok: false,
				code: 'malformed'
			});
		}
	});

	it('refuses a batch over the site cap and a body over the byte cap', async () => {
		const many = Array.from({ length: BATCH_MAX_SITES + 1 }, (_, i) => ({
			siteId: `site_${i}`,
			state: 'active',
			blockAtViews: null
		}));
		expect(await verdict('budget', JSON.stringify({ writes: many }))).toEqual({
			ok: false,
			code: 'too_many'
		});
		expect(
			await verdict('budget', JSON.stringify({ writes: many.slice(0, BATCH_MAX_SITES) }))
		).toMatchObject({ ok: true });
		expect(await verdict('counts', ' '.repeat(BATCH_MAX_BYTES + 1))).toEqual({
			ok: false,
			code: 'too_large'
		});
	});

	it('bounds the hours and months of a read', async () => {
		const read = (hours: number[], months: string[]) =>
			JSON.stringify({ reads: [{ siteId: 's', hours, months }] });
		expect(await verdict('counts', read(Array(48).fill(1), ['2026-11']))).toMatchObject({
			ok: true
		});
		expect(await verdict('counts', read(Array(49).fill(1), []))).toMatchObject({
			code: 'malformed'
		});
		expect(await verdict('counts', read([], ['2026-13']))).toMatchObject({ code: 'malformed' });
	});

	it('keeps the message types apart when both sign with one secret', async () => {
		const asBudget = await verifyBatch(
			'budget',
			headersOf(await signBatch('counts', COUNTS_BODY, { secret: START, now: NOW, id: ID })),
			COUNTS_BODY,
			{ secret: START, now: NOW }
		);
		expect(asBudget).toMatchObject({ ok: false, code: 'bad_signature' });
		const asCounts = await verifyBatch(
			'counts',
			headersOf(await signBatch('budget', BUDGET_BODY, { secret: START, now: NOW, id: ID })),
			BUDGET_BODY,
			{ secret: START, now: NOW }
		);
		expect(asCounts).toMatchObject({ ok: false, code: 'bad_signature' });
	});

	it('falls back to the start secret only for a message type with no secret of its own', () => {
		expect(batchSecretsOf({ start: START })).toEqual({
			budgetSecret: START,
			countsSecret: START
		});
		expect(batchSecretsOf({ budget: BUDGET_SECRET, start: START })).toEqual({
			budgetSecret: BUDGET_SECRET,
			countsSecret: START
		});
		expect(
			batchSecretsOf({ budget: BUDGET_SECRET, counts: COUNTS_SECRET, start: START })
		).toEqual({
			budgetSecret: BUDGET_SECRET,
			countsSecret: COUNTS_SECRET
		});
		expect(batchSecretsOf({ budget: '', counts: undefined, start: START })).toEqual({
			budgetSecret: START,
			countsSecret: START
		});
		expect(batchSecretsOf({})).toEqual({ budgetSecret: undefined, countsSecret: undefined });
	});

	it('gives every refusal a status', () => {
		for (const code of BATCH_REFUSALS) {
			expect(BATCH_REFUSAL_STATUS[code]).toBeGreaterThanOrEqual(400);
		}
	});
});
