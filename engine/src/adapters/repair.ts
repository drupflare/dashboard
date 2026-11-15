import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { factsOfFindings } from '../../../src/shared/health/predicate';
import type {
	NewRepair,
	OwnerAuth,
	RepairAnswer,
	RepairCall,
	RepairLedger,
	RepairReading,
	RepairWorker
} from '../ports';
import {
	REPAIR_COLUMNS,
	switchesOf,
	toRepairRecord,
	type RepairRecord,
	type RepairRow,
	type RepairStatus,
	type SwitchRow
} from '../repair/rows';
import { PermanentError } from '../step';
import { SiteAnswered, siteFetcher } from './site';

const bearer = (auth: OwnerAuth) => ({ authorization: `Bearer ${auth.bearer}` });

const healthAnswer = z.looseObject({
	lastFindings: z.array(z.looseObject({ code: z.string() })).default([]),
	transactionDepth: z.number().optional(),
	quarantined: z.boolean().default(false)
});

const reconcileAnswer = z.looseObject({
	steps: z.array(z.looseObject({ state: z.string() }))
});

function safeJson(text: string | null): unknown {
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function refusedToken(status: number): void {
	if (status === 401 || status === 403) {
		throw new PermanentError('owner_token_rejected', 'the site refused the owner token');
	}
}

export function repairWorkerOf(fetcher: typeof fetch, timeoutMs: number): RepairWorker {
	const fetchSite = siteFetcher(fetcher, timeoutMs);
	const read = async (hostname: string, path: string, auth: OwnerAuth) => {
		const { status, text } = await fetchSite(
			hostname,
			path,
			{ method: 'GET', headers: bearer(auth) },
			(code) => code === 200
		);
		refusedToken(status);
		return { status, json: safeJson(text) };
	};
	return {
		async observe(hostname, auth): Promise<RepairReading> {
			const health = await read(hostname, '/health', auth);
			const parsed = healthAnswer.safeParse(health.json);
			if (health.status >= 500) throw new SiteAnswered(hostname, '/health', health.status);
			if (health.status !== 200 || !parsed.success) {
				throw new PermanentError(
					'health_unreadable',
					`${hostname} gave no readable health answer (${health.status})`
				);
			}
			const findings = parsed.data.lastFindings.map((f) => f.code);
			const report = await read(hostname, '/reconcile', auth);
			const steps = reconcileAnswer.safeParse(report.json);
			const owed =
				report.status === 200 && steps.success
					? steps.data.steps.filter((s) => s.state === 'owed' || s.state === 'failed')
							.length
					: null;
			const inferred = factsOfFindings(findings);
			return {
				findings,
				owed,
				facts: {},
				transactionDepth: parsed.data.transactionDepth ?? inferred.transactionDepth,
				shedding: inferred.shedding,
				quarantined: parsed.data.quarantined
			};
		},

		async call(hostname, call: RepairCall, auth): Promise<RepairAnswer> {
			const { status, text } = await fetchSite(
				hostname,
				call.path,
				{ method: call.method, headers: bearer(auth) },
				() => true
			);
			refusedToken(status);
			return { status, json: safeJson(text) };
		}
	};
}

export class D1RepairLedger implements RepairLedger {
	constructor(private readonly db: D1Database) {}

	async begin(row: NewRepair): Promise<RepairRecord> {
		await this.db
			.prepare(
				`INSERT OR IGNORE INTO repairs (id, organization_id, site_id, repair_id, rung, status,
				observation_before, observation_after, operation_id, undo_of, created_at, finished_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
			)
			.bind(
				row.id,
				row.organizationId,
				row.siteId,
				row.repairId,
				row.rung,
				row.status,
				row.observationBefore,
				row.operationId,
				row.undoOf,
				row.createdAt,
				row.finishedAt
			)
			.run();
		const stored = await this.get(row.organizationId, row.id);
		if (stored === null) throw new Error(`repair ${row.id} is missing after its insert`);
		return stored;
	}

	async finish(
		organizationId: string,
		id: string,
		end: { status: RepairStatus; observationAfter: string | null; finishedAt: number }
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE repairs SET status = ?, observation_after = ?, finished_at = ?
				WHERE organization_id = ? AND id = ? AND status = 'running'`
			)
			.bind(end.status, end.observationAfter, end.finishedAt, organizationId, id)
			.run();
	}

	async undone(organizationId: string, id: string): Promise<void> {
		await this.db
			.prepare(
				`UPDATE repairs SET status = 'undone'
				WHERE organization_id = ? AND id = ? AND status = 'succeeded'`
			)
			.bind(organizationId, id)
			.run();
	}

	async get(organizationId: string, id: string): Promise<RepairRecord | null> {
		const row = await this.db
			.prepare(`SELECT ${REPAIR_COLUMNS} FROM repairs WHERE organization_id = ? AND id = ?`)
			.bind(organizationId, id)
			.first<RepairRow>();
		return row === null ? null : toRepairRecord(row);
	}

	async history(
		organizationId: string,
		siteId: string,
		repairId: string,
		limit: number
	): Promise<RepairRecord[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${REPAIR_COLUMNS} FROM repairs
				WHERE organization_id = ? AND site_id = ? AND repair_id = ?
				ORDER BY created_at DESC, id DESC LIMIT ?`
			)
			.bind(organizationId, siteId, repairId, limit)
			.all<RepairRow>();
		return results.map(toRepairRecord);
	}

	async since(sinceMs: number): Promise<{ orgId: string; atMs: number }[]> {
		const { results } = await this.db
			.prepare(
				`SELECT organization_id, created_at FROM repairs
				WHERE created_at >= ? AND status <> 'refused'`
			)
			.bind(sinceMs)
			.all<{ organization_id: string; created_at: number }>();
		return results.map((row) => ({ orgId: row.organization_id, atMs: row.created_at }));
	}

	async switches(organizationId: string, siteId: string) {
		const { results } = await this.db
			.prepare(
				`SELECT scope, scope_id, auto FROM ladder_switches
				WHERE scope = 'global' OR (scope = 'organization' AND scope_id = ?)
				OR (scope = 'site' AND scope_id = ?)`
			)
			.bind(organizationId, siteId)
			.all<SwitchRow>();
		return switchesOf(results, organizationId, siteId);
	}
}
