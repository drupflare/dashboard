import type { CollegeDBClient } from '@earth-app/collegedb';
import { nowUtc } from '../../shared/utils/time';
import { getSingleUse, putSingleUse, takeSingleUse, takeSingleUseIf } from '../db/repos/single-use';

// records that work once: a code, an OAuth state, a passkey challenge, a pending link. take and
// takeIf must delete and answer in one atomic step, so parallel callers cannot both succeed
export interface OnceStore {
	put(key: string, value: string, expiresAt: number): Promise<void>;
	get(key: string, now: number): Promise<string | null>;
	take(key: string, now: number): Promise<string | null>;
	takeIf(key: string, value: string, now: number): Promise<boolean>;
}

export function collegeOnceStore(getDb: () => Promise<CollegeDBClient>): OnceStore {
	return {
		async put(key, value, expiresAt) {
			await putSingleUse(await getDb(), key, value, expiresAt, nowUtc().toMillis());
		},
		async get(key, now) {
			return getSingleUse(await getDb(), key, now);
		},
		async take(key, now) {
			return takeSingleUse(await getDb(), key, now);
		},
		async takeIf(key, value, now) {
			return takeSingleUseIf(await getDb(), key, value, now);
		}
	};
}
