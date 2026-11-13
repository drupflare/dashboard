import type { D1Database } from '@cloudflare/workers-types';
import {
	ESTATE_BLOB_BYTES,
	ESTATE_SQL,
	toRowRecord,
	type EstateRowDb
} from '../../../src/shared/estate-sql';
import type { EstateStore } from '../ports';

interface AssessmentFacts {
	state: string;
	row_count: number;
	access: string;
}

const NO_FILTER = [null, null, null, null, null, null] as const;

// the same statements the dashboard's own repo runs, against the one database
export function estateStoreOf(db: D1Database): EstateStore {
	return {
		async assessment(orgId, id) {
			const row = await db
				.prepare(ESTATE_SQL.assessment)
				.bind(orgId, id)
				.first<AssessmentFacts>();
			return row === null
				? null
				: { state: row.state, rowCount: row.row_count, access: row.access };
		},
		async numbers(orgId, id) {
			const { results } = await db
				.prepare(ESTATE_SQL.numbers)
				.bind(orgId, id)
				.all<{ number: number }>();
			return results.map((row) => row.number);
		},
		async row(orgId, id, number) {
			const row = await db
				.prepare(ESTATE_SQL.row)
				.bind(orgId, id, number)
				.first<EstateRowDb>();
			return row === null ? null : toRowRecord(row);
		},
		async page(orgId, id, after, count) {
			const { results } = await db
				.prepare(ESTATE_SQL.page)
				.bind(orgId, id, after, ...NO_FILTER, count)
				.all<EstateRowDb>();
			return results.map(toRowRecord);
		},
		async start(orgId, id, now) {
			await db.prepare(ESTATE_SQL.start).bind(now, orgId, id).run();
		},
		async begin(orgId, id, number, now) {
			await db.prepare(ESTATE_SQL.begin).bind(now, orgId, id, number).run();
		},
		async finishRow(orgId, id, number, verdict, now) {
			let text = JSON.stringify(verdict);
			// findings are the only part that grows; the cut keeps the row inside its bound
			let kept = verdict.findings;
			while (text.length > ESTATE_BLOB_BYTES.verdict && kept.length > 1) {
				kept = kept.slice(0, -1);
				text = JSON.stringify({ ...verdict, findings: kept });
			}
			await db
				.prepare(ESTATE_SQL.finishRow)
				.bind(verdict.state, verdict.class, text, now, orgId, id, number)
				.run();
		},
		async skip(orgId, id, now) {
			await db.prepare(ESTATE_SQL.skip).bind(now, orgId, id).run();
		},
		async finish(orgId, id, report, state, now) {
			await db
				.prepare(ESTATE_SQL.finish)
				.bind(state, report === null ? null : JSON.stringify(report), now, orgId, id)
				.run();
		}
	};
}
