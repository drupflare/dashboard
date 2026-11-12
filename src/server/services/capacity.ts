import { Budget, HttpClient, Resources } from '@drupflare/workforce';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { readAccountUsage } from '../../../engine/src/account-usage';
import { readUsageOf } from '../../../engine/src/adapters/workforce';
import {
	KV_NAMESPACE_LIMIT,
	type CapacityView,
	type CreditsView,
	type HeadroomView,
	type UsageView
} from '../../shared/capacity';
import { ApiError } from '../../shared/errors';
import { adminWork } from '../db/repos/admin';
import {
	BillingAccessError,
	readCredits,
	readUsage,
	type BillingFetch
} from '../integrations/cloudflare-billing';

export interface CloudflareReads {
	credits(): Promise<CreditsView>;
	usage(): Promise<Extract<UsageView, { state: 'ok' }>>;
	headroom(): Promise<Extract<HeadroomView, { state: 'ok' }>>;
}

export interface CapacityServices {
	getDb: () => Promise<CollegeDBClient>;
	// null while the Worker has no Cloudflare credentials
	reads: CloudflareReads | null;
	now: () => number;
	cacheMs: number;
}

export const CAPACITY_CACHE_MS = 60_000;

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

function productionServices(): CapacityServices {
	return {
		getDb: notBuilt('The platform store'),
		reads: null,
		now: () => Date.now(),
		cacheMs: CAPACITY_CACHE_MS
	};
}

let installed = productionServices();
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

export function setCapacityServices(over: Partial<CapacityServices>): void {
	installed = { ...installed, ...over };
	cache.clear();
}

export function resetCapacityServices(): void {
	installed = productionServices();
	cache.clear();
}

export function capacityServices(): CapacityServices {
	return installed;
}

async function refuseToWait(): Promise<never> {
	throw new Error('the rate budget is spent');
}

export function cloudflareReadsOf(
	credentials: { accountId: string | undefined; token: string | undefined },
	fetcher: BillingFetch
): CloudflareReads | null {
	const { accountId, token } = credentials;
	if (!accountId || !token) return null;
	const billing = { accountId, token, fetch: fetcher };
	// an admin request fails when the rate budget is spent; the next refresh tries again
	const http = new HttpClient(() => ({ authorization: `Bearer ${token}` }), {
		fetch: fetcher,
		retries: 0,
		sleep: refuseToWait,
		budget: new Budget({ sleep: refuseToWait })
	});
	const resources = new Resources(http, accountId);
	const count = async (read: () => Promise<number>): Promise<number | null> => {
		try {
			return await read();
		} catch {
			return null;
		}
	};
	return {
		credits: () => readCredits(billing),
		usage: () => readUsage(billing),
		headroom: async () => {
			const reading = await readAccountUsage({
				readUsage: () => readUsageOf(http, accountId, resources)
			});
			return {
				state: 'ok',
				kvNamespaces: reading.kvNamespaces,
				kvLimit: KV_NAMESPACE_LIMIT,
				buckets: reading.buckets,
				scripts: await count(
					async () =>
						(await http.request<unknown[]>(`/accounts/${accountId}/workers/scripts`))
							.length
				),
				databases: await count(async () => (await resources.listD1()).length),
				rate: {
					remaining: reading.rate.remaining,
					quota: reading.rate.quota,
					resetSeconds: reading.rate.resetSeconds,
					windowSeconds: reading.rate.windowSeconds
				}
			};
		}
	};
}

// a failed read is kept for the same minute as a good one, so a broken token is not retried per request
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
	const now = installed.now();
	const hit = cache.get(key);
	if (hit !== undefined && now - hit.at < installed.cacheMs) return hit.value as Promise<T>;
	const value = load();
	cache.set(key, { at: now, value });
	return value;
}

// only the error's name is logged: a message from the HTTP client could name a request
function unavailable(section: string, error: unknown): { state: 'unavailable' } {
	console.warn('capacity read failed', section, error instanceof Error ? error.name : 'unknown');
	return { state: 'unavailable' };
}

const creditsSection = (reads: CloudflareReads | null): Promise<CreditsView> =>
	cached('credits', async (): Promise<CreditsView> => {
		if (reads === null) return { state: 'not_configured' };
		try {
			return await reads.credits();
		} catch (error) {
			return error instanceof BillingAccessError
				? { state: 'no_billing_access' }
				: unavailable('credits', error);
		}
	});

const usageSection = (reads: CloudflareReads | null): Promise<UsageView> =>
	cached('usage', async (): Promise<UsageView> => {
		if (reads === null) return { state: 'not_configured' };
		try {
			return await reads.usage();
		} catch (error) {
			return unavailable('usage', error);
		}
	});

const headroomSection = (reads: CloudflareReads | null): Promise<HeadroomView> =>
	cached('headroom', async (): Promise<HeadroomView> => {
		if (reads === null) return { state: 'not_configured' };
		try {
			return await reads.headroom();
		} catch (error) {
			return unavailable('headroom', error);
		}
	});

export async function readCapacity(): Promise<CapacityView> {
	const { reads, getDb, now } = installed;
	const [credits, usage, headroom, work] = await Promise.all([
		creditsSection(reads),
		usageSection(reads),
		headroomSection(reads),
		getDb().then((db) => adminWork(db, now()))
	]);
	return { generatedAt: now(), credits, usage, headroom, work };
}
