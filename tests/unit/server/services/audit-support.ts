import type { CollegeDBClient } from '@earth-app/collegedb';
import type { ChainHead, HeadStore, StoredHead } from '../../../../src/server/services/audit';

export interface AuditRow {
	organization_id: string;
	seq: number;
	prev_hash: string;
	hash: string;
	actor: string;
	action: string;
	target: string;
	detail: string;
	created_at: number;
}

// just enough of the client for append and verify: one organisation, rows in an array
export function fakeAuditDb(rows: AuditRow[]): CollegeDBClient {
	const db = {
		async first() {
			const last = rows.at(-1);
			return last ? { seq: last.seq, hash: last.hash } : null;
		},
		async run(_org: string, _sql: string, p: unknown[]) {
			rows.push({
				organization_id: p[0] as string,
				seq: p[1] as number,
				prev_hash: p[2] as string,
				hash: p[3] as string,
				actor: p[4] as string,
				action: p[5] as string,
				target: p[6] as string,
				detail: p[7] as string,
				created_at: p[8] as number
			});
		},
		async all(_org: string, _sql: string, p: unknown[]) {
			const after = p[1] as number;
			return { results: rows.filter((row) => row.seq > after).slice(0, p[2] as number) };
		},
		async batch(entries: { key: string; bindings: unknown[] }[]) {
			for (const entry of entries) await db.run(entry.key, '', entry.bindings);
			return [
				{
					shard: 'DB',
					indices: entries.map((_, index) => index),
					results: entries.map(() => ({ meta: { changes: 1 } }))
				}
			];
		}
	};
	return db as unknown as CollegeDBClient;
}

export interface MemoryHeads extends HeadStore {
	heads: Map<string, StoredHead>;
	writes: ChainHead[];
}

// the version check and the write share one synchronous step, as an etag precondition does
export function memoryHeads(): MemoryHeads {
	const heads = new Map<string, StoredHead>();
	const writes: ChainHead[] = [];
	let counter = 0;
	return {
		heads,
		writes,
		async get(organizationId) {
			await Promise.resolve();
			const head = heads.get(organizationId);
			return head ? { ...head } : null;
		},
		async put(organizationId, head, expected) {
			await Promise.resolve();
			if ((heads.get(organizationId)?.version ?? null) !== expected) return false;
			heads.set(organizationId, { ...head, version: `v${++counter}` });
			writes.push(head);
			return true;
		}
	};
}
