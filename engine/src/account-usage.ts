import type { Cloudflare, CloudflareUsage } from './ports';
import {
	countCalls,
	type AccountLimits,
	type AccountUsage,
	type ResourcePlan
} from './provision-plan';

export type { CloudflareUsage as AccountUsageReading, RateHeadroom } from './ports';

export interface UsageLimits {
	kvNamespaces: number;
	buckets?: number;
}

// both are retryable on purpose: nothing is lost, and a later run resumes from the record
export class QuotaExhaustedError extends Error {
	readonly code = 'quota_exhausted';
	readonly retryAfterMs = null;

	constructor(
		readonly what: 'kv' | 'r2',
		used: number,
		added: number,
		limit: number
	) {
		super(
			`quota_exhausted: ${what} would reach ${used + added} of ${limit} on this account; free some and retry`
		);
		this.name = 'QuotaExhaustedError';
	}
}

export class RateLimitedError extends Error {
	readonly code = 'rate_limited';

	constructor(
		message: string,
		readonly retryAfterMs: number | null
	) {
		super(`rate_limited: ${message}`);
		this.name = 'RateLimitedError';
	}
}

export class UsageUnreadableError extends Error {
	readonly code = 'usage_unreadable';

	constructor(field: string) {
		super(`usage_unreadable: the account's ${field} could not be read`);
		this.name = 'UsageUnreadableError';
	}
}

export const USAGE_ERROR_CODES = ['quota_exhausted', 'rate_limited', 'usage_unreadable'] as const;

export function retryAfterMsOf(error: unknown): number | null {
	return error instanceof QuotaExhaustedError || error instanceof RateLimitedError
		? error.retryAfterMs
		: null;
}

const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0;

export async function readAccountUsage(
	cloudflare: Pick<Cloudflare, 'readUsage'>
): Promise<CloudflareUsage> {
	const reading = await cloudflare.readUsage();
	if (!isCount(reading.kvNamespaces)) throw new UsageUnreadableError('KV namespace count');
	if (!isCount(reading.buckets)) throw new UsageUnreadableError('bucket count');
	return reading;
}

// what the dry run takes: the response's own numbers where it gave them, the defaults otherwise
export function dryRunArguments(
	reading: CloudflareUsage,
	defaults: AccountLimits
): { limits: AccountLimits; usage: AccountUsage } {
	return {
		limits: {
			kvNamespaces: defaults.kvNamespaces,
			requestsPerWindow: reading.rate.quota ?? defaults.requestsPerWindow,
			windowSeconds: reading.rate.windowSeconds ?? defaults.windowSeconds
		},
		usage: { kvNamespaces: reading.kvNamespaces }
	};
}

// one lookup per resource, one create per resource, and the rollback deletes
export function peakCalls(plan: ResourcePlan): number {
	const calls = countCalls(plan);
	return calls.creates + plan.create.length + calls.rollbackDeletes;
}

export function checkHeadroom(
	plan: ResourcePlan,
	reading: CloudflareUsage,
	limits: UsageLimits | undefined
): void {
	const needed = peakCalls(plan);
	const { remaining, resetSeconds } = reading.rate;
	if (remaining !== null && remaining < needed) {
		throw new RateLimitedError(
			`${remaining} requests left in the window and this create needs up to ${needed}`,
			resetSeconds === null ? null : resetSeconds * 1000
		);
	}
	if (limits === undefined) return;
	const kvAdded = plan.create.filter((resource) => resource.kind === 'kv').length;
	if (reading.kvNamespaces + kvAdded > limits.kvNamespaces) {
		throw new QuotaExhaustedError('kv', reading.kvNamespaces, kvAdded, limits.kvNamespaces);
	}
	const r2Added = plan.create.filter((resource) => resource.kind === 'r2').length;
	if (limits.buckets !== undefined && reading.buckets + r2Added > limits.buckets) {
		throw new QuotaExhaustedError('r2', reading.buckets, r2Added, limits.buckets);
	}
}
