import { generateSigningKey, newId, sha256Digest, type SigningKey } from '@contracts/common';
import type { AuthorityState, RenewalRequest } from '@contracts/site-auth';
import { applyTo, leaseFor, renewFor, signApply } from '../../../dispatch/src/authority';
import { applyIn, readHourIn, type CountWrite } from '../../../dispatch/src/counting';
import type { SiteAuthClient } from '../../../dispatch/src/serve';
import type { CounterStub } from '../../../dispatch/src/spike';
import type { SyncKv } from '../../../dispatch/src/storage';

export function memoryKv(): SyncKv & { size(): number } {
	const map = new Map<string, unknown>();
	return {
		get: <T>(key: string) => map.get(key) as T | undefined,
		put: (key, value) => void map.set(key, structuredClone(value)),
		size: () => map.size
	};
}

export function fakeClock(start = 1_790_000_000_000) {
	let now = start;
	return {
		now: () => now,
		set: (value: number) => void (now = value),
		advance: (ms: number) => void (now += ms)
	};
}

export function newSiteId(): AuthorityState['siteId'] {
	return newId('site') as AuthorityState['siteId'];
}

export async function authorityState(patch: Partial<AuthorityState> = {}): Promise<AuthorityState> {
	return {
		siteId: newSiteId(),
		epoch: 1,
		generation: 1,
		state: 'active',
		risk: 'established',
		limits: { cpuMs: 50, subRequests: 20, viewsPerMonth: 1000 },
		accessRuleHash: await sha256Digest('rules'),
		...patch
	};
}

export type Rig = {
	lease: SigningKey;
	control: SigningKey;
	kv: SyncKv;
	clock: ReturnType<typeof fakeClock>;
	calls: { lease: number; renew: number; apply: number };
	down: { value: boolean };
	client: SiteAuthClient;
	commit(state: AuthorityState): Promise<unknown>;
};

// a hand-written stand-in for one SITE_AUTH object over an in-memory store
export async function makeRig(): Promise<Rig> {
	const lease = await generateSigningKey();
	const control = await generateSigningKey();
	const kv = memoryKv();
	const clock = fakeClock();
	const calls = { lease: 0, renew: 0, apply: 0 };
	const down = { value: false };
	const guard = () => {
		if (down.value) throw new Error('site auth unreachable');
	};
	const client: SiteAuthClient = {
		async lease(request) {
			calls.lease++;
			guard();
			return leaseFor(kv, request, clock.now(), lease.privateKey);
		},
		async renew(request: RenewalRequest) {
			calls.renew++;
			guard();
			return renewFor(kv, request, clock.now(), lease.privateKey);
		},
		async apply(message) {
			calls.apply++;
			guard();
			return applyTo(kv, message, { controlKey: control.publicKey, now: clock.now() });
		}
	};
	return {
		lease,
		control,
		kv,
		clock,
		calls,
		down,
		client,
		commit: async (state) =>
			applyTo(kv, await signApply(state, clock.now(), control.privateKey), {
				controlKey: control.publicKey,
				now: clock.now()
			})
	};
}

// one real counter store per site, with switches for a counter that fails, hangs or waits
export function counterDouble(now: () => number) {
	const stores = new Map<string, SyncKv>();
	const applies: CountWrite[] = [];
	const mode = { fail: false, hang: false, gate: null as Promise<void> | null };
	const storeOf = (siteId: string) => {
		let kv = stores.get(siteId);
		if (!kv) stores.set(siteId, (kv = memoryKv()));
		return kv;
	};
	const stub = (siteId: string): CounterStub => ({
		async apply(write) {
			applies.push(structuredClone(write));
			if (mode.fail) throw new Error('counter down');
			if (mode.hang) return new Promise<never>(() => undefined);
			if (mode.gate) await mode.gate;
			return applyIn(storeOf(siteId), write, now(), siteId);
		},
		read: async (hour) => readHourIn(storeOf(siteId), siteId, hour),
		counts: async () => ({
			since: 0,
			calls: applies.filter((w) => w.siteId === siteId).length,
			refused: 0,
			puts: 0,
			appliedViews: 0,
			duplicateViews: 0
		})
	});
	return { stub, applies, mode };
}

export function deferred() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => (open = resolve));
	return { promise, open };
}
