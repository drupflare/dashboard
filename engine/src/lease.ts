export interface LeaseHolder {
	id: string;
	purpose: string;
	expiresAt: number;
}

// the epoch only ever rises; it survives a release so an old holder can never match a new one
export interface LeaseState {
	epoch: number;
	holder: LeaseHolder | null;
}

export const LEASE_REFUSALS = ['held', 'not_holder', 'stale_epoch', 'expired'] as const;
export type LeaseRefusal = (typeof LEASE_REFUSALS)[number];

export type Refused = { ok: false; code: LeaseRefusal; heldBy?: string; until?: number };
export type Granted = { ok: true; epoch: number; expiresAt: number };

export const EMPTY_LEASE: LeaseState = { epoch: 0, holder: null };

export interface AcquireRequest {
	holder: string;
	purpose: string;
	ttlMs: number;
	now: number;
}

const live = (holder: LeaseHolder | null, now: number): holder is LeaseHolder =>
	holder !== null && now < holder.expiresAt;

// one writer per site whatever its purpose, so a repair and a fleet rollout cannot hold it together
export function acquire(
	state: LeaseState,
	request: AcquireRequest
): { state: LeaseState; result: Granted | Refused } {
	const { holder } = state;
	if (live(holder, request.now)) {
		if (holder.id !== request.holder) {
			return {
				state,
				result: { ok: false, code: 'held', heldBy: holder.id, until: holder.expiresAt }
			};
		}
		// the same holder asking again keeps its epoch and extends its time
		const expiresAt = request.now + request.ttlMs;
		return {
			state: { epoch: state.epoch, holder: { ...holder, expiresAt } },
			result: { ok: true, epoch: state.epoch, expiresAt }
		};
	}
	const epoch = state.epoch + 1;
	const expiresAt = request.now + request.ttlMs;
	return {
		state: { epoch, holder: { id: request.holder, purpose: request.purpose, expiresAt } },
		result: { ok: true, epoch, expiresAt }
	};
}

export interface HolderRequest {
	holder: string;
	epoch: number;
	now: number;
}

export function check(state: LeaseState, request: HolderRequest): Granted | Refused {
	if (request.epoch !== state.epoch) return { ok: false, code: 'stale_epoch' };
	const { holder } = state;
	if (holder === null || holder.id !== request.holder) return { ok: false, code: 'not_holder' };
	if (!live(holder, request.now)) return { ok: false, code: 'expired' };
	return { ok: true, epoch: state.epoch, expiresAt: holder.expiresAt };
}

export function heartbeat(
	state: LeaseState,
	request: HolderRequest & { ttlMs: number }
): { state: LeaseState; result: Granted | Refused } {
	const verdict = check(state, request);
	if (!verdict.ok || state.holder === null) return { state, result: verdict };
	const expiresAt = request.now + request.ttlMs;
	return {
		state: { epoch: state.epoch, holder: { ...state.holder, expiresAt } },
		result: { ok: true, epoch: state.epoch, expiresAt }
	};
}

// releasing what is already free is fine; releasing what another holder took is refused
export function release(
	state: LeaseState,
	request: HolderRequest
): { state: LeaseState; result: { ok: true } | Refused } {
	if (request.epoch !== state.epoch) return { state, result: { ok: false, code: 'stale_epoch' } };
	if (state.holder === null) return { state, result: { ok: true } };
	if (state.holder.id !== request.holder) {
		return { state, result: { ok: false, code: 'not_holder' } };
	}
	return { state: { epoch: state.epoch, holder: null }, result: { ok: true } };
}
