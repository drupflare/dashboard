import type { CollegeDBClient } from '@earth-app/collegedb';
import { toBase64Url } from '../../../../contracts/src/common';
import type { AuditInput } from '../../../../src/server/services/audit';
import { storeOwnerToken, type CustodyDeps } from '../../../../src/server/services/owner-tokens';
import type { SiteHealthServices } from '../../../../src/server/services/site-health';
import { loadKeyRing } from '../../../../src/shared/custody/envelope';
import { ORG as FIXTURE_ORG } from '../../domain/fixtures';
import { MemoryOwnerTokenStore } from './custody-support';

export const SITE = 'site_aaaaaaaa';
export const ORG = FIXTURE_ORG;
export const HOST = 'quiet-oak.drupflare.app';
export const TOKEN = 'owner-token-0123456789-abcdefghij';
export const NOW = Date.parse('2026-11-07T12:00:00.000Z');

export function siteRow(over: Record<string, unknown> = {}) {
	return {
		id: SITE,
		organization_id: ORG,
		name: 'quiet-oak',
		kind: 'drupal',
		category: 'cms',
		plane: 'managed',
		config: 'managed',
		account_id: 'acct_1',
		state: 'active',
		primary_hostname: HOST,
		ready_at: NOW - 1000,
		created_at: NOW - 2000,
		updated_at: NOW - 2000,
		...over
	};
}

export function backupRow(over: Record<string, unknown> = {}) {
	return {
		id: 'bkp_11111111',
		site_id: SITE,
		organization_id: ORG,
		operation_id: 'op_aaaaaaaa',
		bytes: 10,
		sha256: 'a'.repeat(64),
		parts: 1,
		restorable: 1,
		verified: 0,
		label: null,
		created_at: NOW - 500,
		deleted_at: null,
		...over
	};
}

export interface FakeDb {
	site: Record<string, unknown> | null;
	backups: Record<string, unknown>[];
	failBackups: boolean;
	asked: { orgId: string; sql: string }[];
}

// the site query answers only for the organisation that owns the row, as the shard key does
export function fakeDb(state: Partial<FakeDb> = {}): { db: CollegeDBClient; state: FakeDb } {
	const full: FakeDb = {
		site: siteRow(),
		backups: [],
		failBackups: false,
		asked: [],
		...state
	};
	const db = {
		async first(orgId: string, sql: string) {
			full.asked.push({ orgId, sql });
			return full.site !== null && full.site.organization_id === orgId ? full.site : null;
		},
		async all(orgId: string, sql: string) {
			full.asked.push({ orgId, sql });
			if (full.failBackups) throw new Error('the backup query failed');
			return { results: full.backups };
		}
	} as unknown as CollegeDBClient;
	return { db, state: full };
}

export type Fetched = { url: string; init: RequestInit };

export interface World {
	services: SiteHealthServices;
	db: FakeDb;
	audits: AuditInput[];
	fetched: Fetched[];
	clock: { now: number };
	store: MemoryOwnerTokenStore;
}

type Answer = (url: string, init: RequestInit) => Response | Promise<Response>;

// a sealed owner token, a recording fetch and a movable clock
export async function world(
	answer: Answer,
	options: { db?: Partial<FakeDb>; sealed?: boolean; timeoutMs?: number } = {}
): Promise<World> {
	const store = new MemoryOwnerTokenStore();
	const audits: AuditInput[] = [];
	const deps: CustodyDeps = {
		store,
		audit: {
			async append(input) {
				audits.push(input);
			}
		},
		ring: await loadKeyRing({ KEK_V1: toBase64Url(new Uint8Array(32).fill(1)) })
	};
	if (options.sealed !== false) {
		await storeOwnerToken(deps, { siteId: SITE, actor: 'system:create', token: TOKEN });
		audits.length = 0;
	}
	const { db, state } = fakeDb(options.db);
	const fetched: Fetched[] = [];
	const clock = { now: NOW };
	return {
		services: {
			getDb: async () => db,
			custody: async () => deps,
			fetch: async (url, init) => {
				fetched.push({ url, init });
				return answer(url, init);
			},
			now: () => clock.now,
			timeoutMs: options.timeoutMs ?? 5_000
		},
		db: state,
		audits,
		fetched,
		clock,
		store
	};
}

// #region worker answers
// the shape of GET /health on a site: worker/src/do/routes/lifecycle.ts health(), with the nodes
// built as worker/src/ops/health-tree.ts builds them; the step id is the one its doc comment names

type Level = 'ok' | 'info' | 'warn' | 'error' | 'critical';

export interface Finding {
	code: string;
	severity: Exclude<Level, 'ok'>;
	scope: string;
	context: string;
}

export interface WorkerOptions {
	findings?: Finding[];
	reconcile?: { version: number; packVersion: number; state: string; detail: string };
	repair?: { rung: string; code: string | null; strikes: number };
	ledger?: { ts: number; code: string; severity: number; action: string }[];
	import?: { state: string; chunk: number; chunks: number } | null;
	level?: Level;
}

const ORDER: Level[] = ['ok', 'info', 'warn', 'error', 'critical'];
const worst = (levels: Level[]): Level =>
	levels.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), 'ok' as Level);
const STEP_LEVEL: Record<string, Level> = {
	satisfied: 'ok',
	applied: 'ok',
	deferred: 'info',
	owed: 'warn',
	failed: 'error'
};

export function workerHealth(options: WorkerOptions = {}) {
	const findings = options.findings ?? [];
	const reconcile = options.reconcile ?? {
		version: 2,
		packVersion: 2,
		state: 'satisfied',
		detail: ''
	};
	const repair = options.repair ?? { rung: 'observe', code: null, strikes: 0 };
	const stepLevel = STEP_LEVEL[reconcile.state] ?? 'warn';
	const findingNodes = findings.map((f) => ({
		id: `supervisor.${f.code}`,
		source: 'supervisor',
		level: f.severity,
		state: f.severity,
		title: f.scope === '' ? f.code : `${f.code} on ${f.scope}`,
		detail: f.context,
		children: []
	}));
	const nodes = [
		{
			id: 'repair',
			source: 'repair',
			level:
				repair.rung === 'quarantine' || repair.rung === 'rollback'
					? 'critical'
					: repair.strikes > 0
						? 'warn'
						: 'ok',
			state: repair.rung,
			title: 'Repair ladder',
			detail: repair.code === null ? '' : `${repair.strikes} strike(s) on ${repair.code}`,
			children: []
		},
		{
			id: 'reconcile',
			source: 'reconcile',
			level: stepLevel,
			state: reconcile.version < reconcile.packVersion ? 'behind' : 'current',
			title: 'Reconciliation with the shipping pack',
			detail: `version ${reconcile.version} of ${reconcile.packVersion}`,
			children: [
				{
					id: 'reconcile.owner-tiers',
					source: 'reconcile',
					level: stepLevel,
					state: reconcile.state,
					title: 'Owner tiers are in place',
					detail: reconcile.detail,
					children: []
				}
			]
		},
		{
			id: 'supervisor',
			source: 'supervisor',
			level: worst(findingNodes.map((n) => n.level)),
			state: findings.length === 0 ? 'clear' : 'findings',
			title: 'Host tripwires from the last supervised alarm',
			detail: findings.length === 0 ? '' : `${findings.length} finding(s)`,
			children: findingNodes
		}
	];
	return {
		tree: { level: options.level ?? worst(nodes.map((n) => n.level as Level)), nodes },
		repair: { ...repair, quarantinedAt: null, lastRollbackAt: null },
		quarantined: repair.rung === 'quarantine',
		rollback: { rollback: false, reason: 'not quarantined' },
		import: options.import ?? null,
		advisories: { fresh: false, ageS: 0 },
		version: { id: 'v1', tag: null, timestamp: null },
		lastFindings: findings,
		ledger: (options.ledger ?? []).map((row) => ({
			ts: row.ts,
			code: row.code,
			severity: row.severity,
			scope: '',
			context: '',
			action: row.action,
			outcome: '',
			attempt: 0
		})),
		ledgerRows: (options.ledger ?? []).length
	};
}

export const ok = (body: unknown): Response => Response.json(body);

// #endregion
