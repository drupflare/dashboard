import { describe, expect, it } from 'vitest';
import {
	BillingAccessError,
	BillingReadError,
	readCredits,
	readUsage,
	type BillingConfig
} from '../../../../src/server/integrations/cloudflare-billing';
import { dollars } from '../../../../src/shared/capacity';

const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'secret-token-value-0123456789';

interface Seen {
	url: string;
	method: string;
	authorization: string | null;
}

function config(answer: () => Response | Promise<Response>) {
	const seen: Seen[] = [];
	const billing: BillingConfig = {
		accountId: ACCOUNT,
		token: TOKEN,
		fetch: async (input, init) => {
			seen.push({
				url: String(input),
				method: init?.method ?? 'GET',
				authorization: new Headers(init?.headers).get('authorization')
			});
			return answer();
		}
	};
	return { billing, seen };
}

const envelope = (result: unknown, status = 200) =>
	new Response(JSON.stringify({ success: status < 400, errors: [], messages: [], result }), {
		status
	});

const grant = {
	has_record: true,
	eligible: true,
	confirmed_balance_cents: 999_958,
	original_amount_cents: 1_000_000,
	currency: 'USD',
	valid_from: '2026-11-12T00:00:00Z',
	valid_to: '2027-11-12T00:00:00Z',
	days_remaining: 363,
	percent_consumed: 0.0042,
	projected_depletion_date: null
};

const caught = (run: Promise<unknown>) =>
	run.then(
		() => null,
		(error: unknown) => error
	);

describe('readCredits', () => {
	it('reads the grant with one GET and turns cents into dollars', async () => {
		const { billing, seen } = config(() => envelope(grant));
		const view = await readCredits(billing);
		expect(view).toEqual({
			state: 'ok',
			currency: 'USD',
			balanceCents: 999_958,
			originalCents: 1_000_000,
			usedCents: 42,
			daysRemaining: 363,
			validFrom: '2026-11-12T00:00:00Z',
			validTo: '2027-11-12T00:00:00Z',
			projectedDepletion: null
		});
		if (view.state !== 'ok') throw new Error('expected a grant');
		expect(dollars(view.balanceCents, view.currency)).toBe('$9,999.58');
		expect(dollars(view.originalCents, view.currency)).toBe('$10,000.00');
		expect(dollars(view.usedCents, view.currency)).toBe('$0.42');
		expect(seen).toEqual([
			{
				url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/billing/credits`,
				method: 'GET',
				authorization: `Bearer ${TOKEN}`
			}
		]);
	});

	it('answers none for an account with no credit record', async () => {
		const { billing } = config(() => envelope({ has_record: false, eligible: false }));
		expect(await readCredits(billing)).toEqual({ state: 'none' });
	});

	it('never reports a negative amount used and drops dates it cannot parse', async () => {
		const { billing } = config(() =>
			envelope({ ...grant, confirmed_balance_cents: 1_000_100, valid_to: 'soon' })
		);
		const view = await readCredits(billing);
		expect(view).toMatchObject({ usedCents: 0, validTo: null });
	});

	it('refuses with a typed error on 401 and 403 and keeps the token out of it', async () => {
		for (const status of [401, 403]) {
			const { billing } = config(() => envelope(null, status));
			const error = await caught(readCredits(billing));
			expect(error).toBeInstanceOf(BillingAccessError);
			expect(String((error as Error).message)).not.toContain(TOKEN);
		}
	});

	it('raises a read error for a server failure, a non-JSON body and a network failure', async () => {
		const failures = [
			() => envelope(null, 500),
			() => new Response('<html>', { status: 200 }),
			() => Promise.reject(new TypeError(`could not reach ${TOKEN}`))
		];
		for (const answer of failures) {
			const { billing } = config(answer);
			const error = await caught(readCredits(billing));
			expect(error).toBeInstanceOf(BillingReadError);
			expect((error as Error).message).not.toContain(TOKEN);
			expect((error as Error).message).not.toContain(ACCOUNT);
		}
	});

	it('raises a read error when the answer has a shape it does not know', async () => {
		for (const result of [
			{ has_record: true },
			{ ...grant, confirmed_balance_cents: '999958' },
			{ ...grant, currency: 'dollars' },
			'nothing'
		]) {
			const { billing } = config(() => envelope(result));
			expect(await caught(readCredits(billing))).toBeInstanceOf(BillingReadError);
		}
	});
});

const row = (service: string, cost: number, day: string, currency = 'USD') => ({
	ServiceName: service,
	ChargePeriodStart: `${day}T00:00:00Z`,
	ConsumedQuantity: 10,
	EffectiveCost: cost,
	ListCost: cost,
	BilledCost: 0,
	BillingCurrency: currency
});

describe('readUsage', () => {
	it('groups the daily rows by service, sums before rounding and sorts by cost', async () => {
		const { billing, seen } = config(() =>
			envelope([
				row('Workers KV', 0.004, '2026-11-01'),
				row('Workers KV', 0.004, '2026-11-02'),
				row('Workers KV', 0.004, '2026-11-03'),
				row('R2', 1.5, '2026-11-02'),
				row('R2', 2.25, '2026-11-12'),
				row('Durable Objects', 3.75, '2026-11-05')
			])
		);
		const view = await readUsage(billing);
		expect(view).toEqual({
			state: 'ok',
			currency: 'USD',
			from: '2026-11-01',
			through: '2026-11-12',
			totalCents: 751,
			services: [
				{ name: 'Durable Objects', cents: 375 },
				{ name: 'R2', cents: 375 },
				{ name: 'Workers KV', cents: 1 }
			]
		});
		expect(seen.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/billable-usage`
		]);
	});

	it('answers an empty period with no services and no currency', async () => {
		const { billing } = config(() => envelope([]));
		expect(await readUsage(billing)).toEqual({
			state: 'ok',
			currency: null,
			from: null,
			through: null,
			totalCents: 0,
			services: []
		});
	});

	it('raises a read error for an unexpected shape or mixed currencies', async () => {
		for (const result of [
			{ rows: [] },
			[{ ServiceName: 'R2', EffectiveCost: 'free', BillingCurrency: 'USD' }],
			[{ EffectiveCost: 1, BillingCurrency: 'USD' }],
			[row('R2', 1, '2026-11-01'), row('R2', 1, '2026-11-02', 'EUR')]
		]) {
			const { billing } = config(() => envelope(result));
			expect(await caught(readUsage(billing))).toBeInstanceOf(BillingReadError);
		}
	});

	it('refuses with the access error and reads other failures as a read error', async () => {
		expect(await caught(readUsage(config(() => envelope(null, 403)).billing))).toBeInstanceOf(
			BillingAccessError
		);
		expect(await caught(readUsage(config(() => envelope(null, 503)).billing))).toBeInstanceOf(
			BillingReadError
		);
	});
});
