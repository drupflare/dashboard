import { z } from 'zod';
import type { CreditsView, ServiceCost, UsageView } from '../../shared/capacity';

export type BillingFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BillingConfig {
	accountId: string;
	token: string;
	fetch: BillingFetch;
	baseUrl?: string;
	timeoutMs?: number;
}

export class BillingAccessError extends Error {
	readonly code = 'no_billing_access';

	constructor() {
		super('the token has no billing access');
		this.name = 'BillingAccessError';
	}
}

// the message never carries the token, the URL or any part of a response
export class BillingReadError extends Error {
	readonly code = 'billing_unreadable';

	constructor(what: string) {
		super(`the billing read failed: ${what}`);
		this.name = 'BillingReadError';
	}
}

const API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 10_000;

async function read(config: BillingConfig, path: string): Promise<unknown> {
	let response: Response;
	try {
		response = await config.fetch(
			`${config.baseUrl ?? API}/accounts/${encodeURIComponent(config.accountId)}${path}`,
			{
				method: 'GET',
				headers: { authorization: `Bearer ${config.token}`, accept: 'application/json' },
				signal: AbortSignal.timeout(config.timeoutMs ?? TIMEOUT_MS)
			}
		);
	} catch {
		throw new BillingReadError('the request did not complete');
	}
	if (response.status === 401 || response.status === 403) throw new BillingAccessError();
	if (!response.ok) throw new BillingReadError(`the API answered ${response.status}`);
	try {
		return await response.json();
	} catch {
		throw new BillingReadError('the body was not JSON');
	}
}

const currency = z.string().regex(/^[A-Z]{3}$/);

const credits = z.object({
	result: z.object({
		has_record: z.boolean().optional(),
		confirmed_balance_cents: z.number().int().optional(),
		original_amount_cents: z.number().int().optional(),
		currency: currency.optional(),
		days_remaining: z.number().nullish(),
		valid_from: z.string().nullish(),
		valid_to: z.string().nullish(),
		projected_depletion_date: z.string().nullish()
	})
});

const dateOrNull = (value: string | null | undefined): string | null =>
	typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

export async function readCredits(config: BillingConfig): Promise<CreditsView> {
	const body = credits.safeParse(await read(config, '/billing/credits'));
	if (!body.success) throw new BillingReadError('the credits answer had an unexpected shape');
	const result = body.data.result;
	if (result.has_record === false) return { state: 'none' };
	const { confirmed_balance_cents: balance, original_amount_cents: original } = result;
	if (balance === undefined || original === undefined || result.currency === undefined) {
		throw new BillingReadError('the credits answer had an unexpected shape');
	}
	return {
		state: 'ok',
		currency: result.currency,
		balanceCents: balance,
		originalCents: original,
		usedCents: Math.max(0, original - balance),
		daysRemaining: result.days_remaining ?? null,
		validFrom: dateOrNull(result.valid_from),
		validTo: dateOrNull(result.valid_to),
		projectedDepletion: dateOrNull(result.projected_depletion_date)
	};
}

const usage = z.object({
	result: z.array(
		z.object({
			ServiceName: z.string().min(1),
			ChargePeriodStart: z.string().optional(),
			EffectiveCost: z.number(),
			BillingCurrency: currency
		})
	)
});

// the API returns daily rows and no totals, so the sum is here
export async function readUsage(
	config: BillingConfig
): Promise<Extract<UsageView, { state: 'ok' }>> {
	const body = usage.safeParse(await read(config, '/billable-usage'));
	if (!body.success) throw new BillingReadError('the usage answer had an unexpected shape');
	const rows = body.data.result;
	const code = rows[0]?.BillingCurrency ?? null;
	const sums = new Map<string, number>();
	const days: string[] = [];
	for (const row of rows) {
		if (row.BillingCurrency !== code) throw new BillingReadError('the usage mixes currencies');
		sums.set(row.ServiceName, (sums.get(row.ServiceName) ?? 0) + row.EffectiveCost);
		const start = row.ChargePeriodStart;
		if (start !== undefined && Number.isFinite(Date.parse(start)))
			days.push(start.slice(0, 10));
	}
	days.sort();
	// a row can be under a cent, so each service is rounded once, after its rows are added
	const services: ServiceCost[] = [...sums]
		.map(([name, cost]) => ({ name, cents: Math.round(cost * 100) }))
		.sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
	return {
		state: 'ok',
		currency: code,
		from: days[0] ?? null,
		through: days.at(-1) ?? null,
		totalCents: services.reduce((sum, service) => sum + service.cents, 0),
		services
	};
}
