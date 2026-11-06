import {
	OwnerTokenConflictError,
	type OwnerTokenRecord,
	type OwnerTokenStore,
	type StoredOwnerToken
} from '../../../../src/server/services/owner-tokens';

const tick = () => Promise.resolve();

// the version check and the write share one synchronous step, as the d1 statement does; with
// `interleave` every call yields first so parallel callers overlap
export class MemoryOwnerTokenStore implements OwnerTokenStore {
	rows = new Map<string, StoredOwnerToken>();
	reads = 0;

	constructor(private readonly interleave = false) {}

	async get(siteId: string) {
		this.reads++;
		if (this.interleave) await tick();
		const row = this.rows.get(siteId);
		return row ? structuredClone(row) : null;
	}

	async put(siteId: string, value: OwnerTokenRecord, expected: number | null) {
		if (this.interleave) await tick();
		const current = this.rows.get(siteId);
		if ((current?.version ?? null) !== expected) throw new OwnerTokenConflictError(siteId);
		const version = (current?.version ?? 0) + 1;
		this.rows.set(siteId, structuredClone({ ...value, version }));
		return version;
	}
}
