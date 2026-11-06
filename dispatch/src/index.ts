import type { Lease } from '@contracts/site-auth';
import type { UsageCounter } from './counter';
import { serve, type ServeDeps, type SiteAuthClient } from './serve';
import type { SiteAuth } from './site-auth';
import { allocatePastLimit, createSpike, type CounterStub, type Spike } from './spike';
import { counterFor, writeView } from './usage';

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
};

// isolate-wide state: leases are reused across requests until they expire
const cache = new Map<string, Lease>();
const inflight: ServeDeps['inflight'] = new Map();
const revoked = new Set<string>();
let spike: Spike | undefined;

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

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return serve(request, {
			spike: spikeFor(env, ctx),
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
