import { DurableObject } from 'cloudflare:workers';
import {
	acquire,
	check,
	EMPTY_LEASE,
	heartbeat,
	release,
	type AcquireRequest,
	type Granted,
	type HolderRequest,
	type LeaseState,
	type Refused
} from './lease';

const KEY = 'lease';

export class SiteLease extends DurableObject {
	private read(): LeaseState {
		return this.ctx.storage.kv.get<LeaseState>(KEY) ?? EMPTY_LEASE;
	}

	private write(state: LeaseState): void {
		this.ctx.storage.kv.put(KEY, state);
	}

	acquire(request: Omit<AcquireRequest, 'now'>): Granted | Refused {
		const { state, result } = acquire(this.read(), { ...request, now: Date.now() });
		this.write(state);
		return result;
	}

	heartbeat(request: Omit<HolderRequest, 'now'> & { ttlMs: number }): Granted | Refused {
		const { state, result } = heartbeat(this.read(), { ...request, now: Date.now() });
		this.write(state);
		return result;
	}

	release(request: Omit<HolderRequest, 'now'>): { ok: true } | Refused {
		const { state, result } = release(this.read(), { ...request, now: Date.now() });
		this.write(state);
		return result;
	}

	check(request: Omit<HolderRequest, 'now'>): Granted | Refused {
		return check(this.read(), { ...request, now: Date.now() });
	}
}
