import { DurableObject } from 'cloudflare:workers';
import { ApiGovernor, type Admission, type GovernorState, type RateHeaders } from './api-governor';

const KEY = 'governor';

function headersOf(limit: string | null, limitPolicy: string | null): RateHeaders {
	const values = new Map([
		['ratelimit', limit],
		['ratelimit-policy', limitPolicy]
	]);
	return { get: (name) => values.get(name) ?? null };
}

// one object per Cloudflare account, so every isolate that spends on that account shares one count
export class ApiBudget extends DurableObject {
	private load(): ApiGovernor {
		return new ApiGovernor(this.ctx.storage.kv.get<GovernorState>(KEY));
	}

	private save(governor: ApiGovernor): void {
		this.ctx.storage.kv.put(KEY, governor.state);
	}

	admit(policy: string, now: number): Admission {
		const governor = this.load();
		const admission = governor.admit(policy, now);
		this.save(governor);
		return admission;
	}

	observe(policy: string, limit: string | null, limitPolicy: string | null, now: number): void {
		const governor = this.load();
		governor.observe(policy, headersOf(limit, limitPolicy), now);
		this.save(governor);
	}

	retryAfter(policy: string, seconds: number, now: number): void {
		const governor = this.load();
		governor.retryAfter(policy, seconds, now);
		this.save(governor);
	}
}
