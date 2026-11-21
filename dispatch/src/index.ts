import type { Lease } from '@contracts/site-auth';
import type { CountsReader } from './control-counts';
import type { UsageCounter } from './counter';
import { serve, type ServeDeps, type SiteAuthClient } from './serve';
import type { SiteAuth } from './site-auth';
import {
	allocatePastLimit,
	createSpike,
	randomOrigin,
	type CounterStub,
	type Spike
} from './spike';
import { counterFor, writeView } from './usage';
import { createViewCounter, type ViewCounter } from './view-counter';

export { UsageCounter } from './counter';
export { Names } from './names';
export { SiteAuth } from './site-auth';

export type Env = {
	HOSTS_KV: KVNamespace;
	SITE_AUTH: DurableObjectNamespace<SiteAuth>;
	USAGE_COUNTER: DurableObjectNamespace<UsageCounter>;
	DISPATCH: DispatchNamespace;
	USAGE?: AnalyticsEngineDataset;
	LEASE_PUBLIC_KEY: string;
	CONTROL_PUBLIC_KEY: string;
	CONTROL_HOST?: string;
	SPIKE_MODE?: string;
	GATE_PUBLIC_KEY?: string;
	GATE_ORIGIN?: string;
};

// isolate-wide state: leases are reused across requests until they expire
const cache = new Map<string, Lease>();
const inflight: ServeDeps['inflight'] = new Map();
const revoked = new Set<string>();
const seenAssertions = new Set<string>();
let spike: Spike | undefined;
let viewCounter: ViewCounter | undefined;

// built on first use in an isolate; only the stage config sets SPIKE_MODE
function spikeFor(env: Env, ctx: ExecutionContext): Spike | undefined {
	if (env.SPIKE_MODE !== '1') return undefined;
	spike ??= createSpike({
		controlKey: env.CONTROL_PUBLIC_KEY,
		now: Date.now,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		readMechanism: (siteId) => env.HOSTS_KV.get(`mech:${siteId}`),
		counter: (siteId) => counterFor(env.USAGE_COUNTER, siteId) as unknown as CounterStub,
		evict: () => allocatePastLimit()
	});
	spike.bind((promise) => ctx.waitUntil(promise));
	return spike;
}

// one counting service per isolate; the spike's own mechanisms are separate and only the stage sets them
function viewCounterFor(env: Env): ViewCounter {
	viewCounter ??= createViewCounter({
		origin: randomOrigin(),
		now: Date.now,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		send: (write) => counterFor(env.USAGE_COUNTER, write.siteId).apply(write)
	});
	return viewCounter;
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return serve(request, {
			spike: spikeFor(env, ctx),
			counter: viewCounterFor(env),
			controlKey: env.CONTROL_PUBLIC_KEY,
			counts: (siteId) => counterFor(env.USAGE_COUNTER, siteId) as unknown as CountsReader,
			gate:
				env.GATE_PUBLIC_KEY && env.GATE_ORIGIN
					? {
							publicKey: env.GATE_PUBLIC_KEY,
							origin: env.GATE_ORIGIN,
							seen: seenAssertions
						}
					: undefined,
			now: Date.now,
			publicKey: env.LEASE_PUBLIC_KEY,
			controlHost: env.CONTROL_HOST,
			readRoute: (host) => env.HOSTS_KV.get(host),
			siteAuth: (siteId) =>
				env.SITE_AUTH.get(env.SITE_AUTH.idFromName(siteId)) as unknown as SiteAuthClient,
			tenant: (script, limits) => env.DISPATCH.get(script, {}, { limits }),
			cache,
			inflight,
			revoked,
			waitUntil: (promise) => ctx.waitUntil(promise),
			onView: (view) => writeView(env.USAGE, view)
		});
	}
} satisfies ExportedHandler<Env>;
