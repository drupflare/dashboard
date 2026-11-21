import type { CollegeDBClient } from '@earth-app/collegedb';
import type { StateLedger, StateRecord } from '../../services/budget-enforcement';

// the ledger is one logical table, so every row shares one shard key, as the directory rows do
export const LEDGER_KEY = 'budget-ledger';

// a bound list stays well under the D1 parameter limit
const SITE_CHUNK = 50;

interface StateDb {
	site_id: string;
	state: 'ok' | 'over-budget';
	reason: 'site-budget' | 'org-budget' | null;
	mode: 'shadow' | 'on';
	block_at_views: number | null;
	written_at: number;
}

const COLUMNS = 'site_id, state, reason, mode, block_at_views, written_at';

const toRecord = (row: StateDb): StateRecord => ({
	state: row.state,
	reason: row.reason,
	mode: row.mode,
	blockAtViews: row.block_at_views,
	writtenAt: row.written_at
});

export async function getStates(
	db: CollegeDBClient,
	siteIds: readonly string[]
): Promise<Map<string, StateRecord>> {
	const out = new Map<string, StateRecord>();
	for (let i = 0; i < siteIds.length; i += SITE_CHUNK) {
		const chunk = siteIds.slice(i, i + SITE_CHUNK);
		const { results } = await db.all<StateDb>(
			LEDGER_KEY,
			`SELECT ${COLUMNS} FROM budget_states WHERE site_id IN (${chunk.map(() => '?').join(', ')})`,
			chunk
		);
		for (const row of results) out.set(row.site_id, toRecord(row));
	}
	return out;
}

export async function putState(
	db: CollegeDBClient,
	siteId: string,
	record: StateRecord,
	writtenAt: number
): Promise<void> {
	await db.run(
		LEDGER_KEY,
		`INSERT INTO budget_states (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (site_id) DO UPDATE SET state = excluded.state, reason = excluded.reason,
		 mode = excluded.mode, block_at_views = excluded.block_at_views,
		 written_at = excluded.written_at`,
		[
			siteId,
			record.state,
			record.reason,
			record.mode,
			record.blockAtViews ?? null,
			record.writtenAt ?? writtenAt
		]
	);
}

export function collegeStateLedger(
	getDb: () => Promise<CollegeDBClient>,
	now: () => number
): StateLedger {
	return {
		async get(siteId) {
			return (await getStates(await getDb(), [siteId])).get(siteId) ?? null;
		},
		async getMany(siteIds) {
			return getStates(await getDb(), siteIds);
		},
		async set(siteId, record) {
			await putState(await getDb(), siteId, record, now());
		}
	};
}
