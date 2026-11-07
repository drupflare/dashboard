import type { D1Database } from '@cloudflare/workers-types';
import type { Operation } from '@contracts/operations';
import type { SiteCategory, SiteConfig, SitePlane } from '@contracts/sites';
import type { ResourceKind } from '../provision-plan';
import { OPEN_STATUSES, OperationError, resolveIdempotent, type OperationStep } from './state';

export interface NewOperationRecord {
	operation: Operation;
	accountId: string | null;
	siteId: string | null;
}

export interface SiteResourceRow {
	id: string;
	siteId: string;
	accountId: string;
	kind: ResourceKind;
	binding: string;
	name: string;
	providerId: string;
	createdByOperation: string;
	createdAt: number;
	deletedAt: number | null;
}

export type NewSiteResource = Omit<SiteResourceRow, 'id' | 'createdAt' | 'deletedAt'>;

export type SiteRecord = {
	id: string;
	organizationId: string;
	name: string;
	plane: string;
	accountId: string;
	category: SiteCategory;
	config: SiteConfig;
	releaseId?: string | null;
	adminName?: string | null;
	adminMail?: string | null;
};

export type SiteRowState = 'active' | 'suspended' | 'tombstoned' | 'purge-eligible' | 'deleted';

// a create that ended or never started and left a live row that never became ready; the account is
// null until activation
export interface StrandedCreateRow {
	operationId: string;
	siteId: string;
	accountId: string | null;
	plane: SitePlane;
	config: SiteConfig;
	hostname: string | null;
}

export interface OperationStore {
	begin(record: NewOperationRecord): Promise<{ operation: Operation; created: boolean }>;
	get(id: string): Promise<Operation | null>;
	findByKey(orgId: string, idempotencyKey: string): Promise<Operation | null>;
	save(prev: Operation, next: Operation): Promise<Operation>;
	mutate(id: string, change: (operation: Operation) => Operation): Promise<Operation>;
	runningProductionDeploys(accountId: string, excludeId: string): Promise<number>;
	recordResource(resource: NewSiteResource, now: number): Promise<SiteResourceRow>;
	liveResources(siteId: string): Promise<SiteResourceRow[]>;
	allResources(siteId: string): Promise<SiteResourceRow[]>;
	markResourceDeleted(id: string, now: number): Promise<void>;
	activateSite(site: SiteRecord, now: number): Promise<void>;
	setSiteRelease(siteId: string, releaseId: string, now: number): Promise<void>;
	setSiteState(siteId: string, state: SiteRowState, now: number): Promise<void>;
	siteState(siteId: string): Promise<SiteRowState | null>;
	strandedCreates(failedBefore: number, limit: number): Promise<StrandedCreateRow[]>;
}

export class StaleWriteError extends OperationError {
	constructor(operationId: string) {
		super('stale_write', `${operationId} changed since it was read, so this write lost`);
	}
}

type OperationRow = {
	id: string;
	organization_id: string;
	type: string;
	status: string;
	idempotency_key: string;
	target_ids: string;
	preconditions: string;
	plan_digest: string;
	fencing_epoch: number;
	blast_radius: string;
	rollback_point: string | null;
	cursor: string | null;
	verification: string;
	final_observation: string | null;
	budget: string;
	created_at: number;
	updated_at: number;
	version: number;
};

type StepRow = {
	id: string;
	name: string;
	state: string;
	attempt: number;
	started_at: number | null;
	finished_at: number | null;
	error: string | null;
};

type ResourceRow = {
	id: string;
	site_id: string;
	account_id: string;
	kind: string;
	binding: string;
	name: string;
	provider_id: string;
	created_by_operation: string;
	created_at: number;
	deleted_at: number | null;
};

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (value: string) => Date.parse(value);
const isoOrNull = (value: number | null) => (value === null ? null : iso(value));
const msOrNull = (value: string | null) => (value === null ? null : ms(value));

function toStep(row: StepRow): OperationStep {
	return {
		id: row.id,
		name: row.name,
		state: row.state,
		attempt: row.attempt,
		startedAt: isoOrNull(row.started_at),
		finishedAt: isoOrNull(row.finished_at),
		error: row.error
	} as OperationStep;
}

// the dashboard writes the same row and bumps `version`, so a read remembers the version it saw
const versions = new WeakMap<Operation, number>();

function toOperation(row: OperationRow, steps: StepRow[]): Operation {
	const operation = {
		id: row.id,
		orgId: row.organization_id,
		type: row.type,
		status: row.status,
		idempotencyKey: row.idempotency_key,
		targetIds: JSON.parse(row.target_ids),
		preconditions: JSON.parse(row.preconditions),
		planDigest: row.plan_digest,
		fencingEpoch: row.fencing_epoch,
		blastRadius: JSON.parse(row.blast_radius),
		rollbackPoint: row.rollback_point,
		cursor: row.cursor,
		steps: steps.map(toStep),
		verification: row.verification,
		finalObservation: row.final_observation === null ? null : JSON.parse(row.final_observation),
		budget: JSON.parse(row.budget),
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at)
	} as Operation;
	versions.set(operation, row.version);
	return operation;
}

function toResource(row: ResourceRow): SiteResourceRow {
	return {
		id: row.id,
		siteId: row.site_id,
		accountId: row.account_id,
		kind: row.kind as ResourceKind,
		binding: row.binding,
		name: row.name,
		providerId: row.provider_id,
		createdByOperation: row.created_by_operation,
		createdAt: row.created_at,
		deletedAt: row.deleted_at
	};
}

const isUnique = (error: unknown) =>
	error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

// these never change after the plan froze
function assertFrozen(prev: Operation, next: Operation): void {
	const same =
		prev.id === next.id &&
		prev.orgId === next.orgId &&
		prev.type === next.type &&
		prev.idempotencyKey === next.idempotencyKey &&
		prev.planDigest === next.planDigest &&
		prev.createdAt === next.createdAt &&
		JSON.stringify(prev.targetIds) === JSON.stringify(next.targetIds) &&
		JSON.stringify(prev.blastRadius) === JSON.stringify(next.blastRadius) &&
		JSON.stringify(prev.budget) === JSON.stringify(next.budget) &&
		prev.steps.length === next.steps.length &&
		prev.steps.every((step, index) => step.id === next.steps[index]?.id);
	if (!same)
		throw new OperationError('plan_frozen', `${prev.id} is frozen and cannot change shape`);
}

export class D1OperationStore implements OperationStore {
	constructor(private readonly db: D1Database) {}

	async begin(record: NewOperationRecord) {
		const { operation, accountId, siteId } = record;
		const known = await this.findByKey(operation.orgId, operation.idempotencyKey);
		if (known !== null) {
			resolveIdempotent(known, operation.planDigest);
			return { operation: known, created: false };
		}
		const insert = this.db
			.prepare(
				`INSERT INTO operations (id, organization_id, account_id, site_id, type, status,
				idempotency_key, target_ids, preconditions, plan_digest, fencing_epoch, blast_radius,
				rollback_point, cursor, verification, final_observation, budget, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				operation.id,
				operation.orgId,
				accountId,
				siteId,
				operation.type,
				operation.status,
				operation.idempotencyKey,
				JSON.stringify(operation.targetIds),
				JSON.stringify(operation.preconditions),
				operation.planDigest,
				operation.fencingEpoch,
				JSON.stringify(operation.blastRadius),
				operation.rollbackPoint,
				operation.cursor,
				operation.verification,
				operation.finalObservation === null
					? null
					: JSON.stringify(operation.finalObservation),
				JSON.stringify(operation.budget),
				ms(operation.createdAt),
				ms(operation.updatedAt)
			);
		const steps = operation.steps.map((step, position) =>
			this.db
				.prepare(
					`INSERT INTO operation_steps (operation_id, id, position, name, state, attempt,
					started_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					operation.id,
					step.id,
					position,
					step.name,
					step.state,
					step.attempt,
					msOrNull(step.startedAt),
					msOrNull(step.finishedAt),
					step.error
				)
		);
		try {
			await this.db.batch([insert, ...steps]);
		} catch (error) {
			if (!isUnique(error)) throw error;
			// a concurrent begin with the same key won; return its operation
			const winner = await this.findByKey(operation.orgId, operation.idempotencyKey);
			if (winner === null) throw error;
			resolveIdempotent(winner, operation.planDigest);
			return { operation: winner, created: false };
		}
		return { operation, created: true };
	}

	async get(id: string): Promise<Operation | null> {
		const [operations, steps] = await this.db.batch<OperationRow | StepRow>([
			this.db.prepare('SELECT * FROM operations WHERE id = ?').bind(id),
			this.db
				.prepare(
					`SELECT id, name, state, attempt, started_at, finished_at, error
					FROM operation_steps WHERE operation_id = ? ORDER BY position`
				)
				.bind(id)
		]);
		const row = operations?.results[0] as OperationRow | undefined;
		return row === undefined ? null : toOperation(row, (steps?.results ?? []) as StepRow[]);
	}

	async findByKey(orgId: string, idempotencyKey: string): Promise<Operation | null> {
		const row = await this.db
			.prepare('SELECT id FROM operations WHERE organization_id = ? AND idempotency_key = ?')
			.bind(orgId, idempotencyKey)
			.first<{ id: string }>();
		return row === null ? null : this.get(row.id);
	}

	// steps go first, guarded by the version the writer read; the operation row is the compare and swap.
	// An operation that was not read from this store has no version and falls back to updated_at
	async save(prev: Operation, next: Operation): Promise<Operation> {
		assertFrozen(prev, next);
		const seen = versions.get(prev);
		const guard = seen === undefined ? 'updated_at' : 'version';
		const version = seen === undefined ? ms(prev.updatedAt) : seen;
		const statements = next.steps.flatMap((step, position) => {
			const before = prev.steps[position];
			if (before !== undefined && JSON.stringify(before) === JSON.stringify(step)) return [];
			return [
				this.db
					.prepare(
						`UPDATE operation_steps SET state = ?, attempt = ?, started_at = ?, finished_at = ?,
						error = ? WHERE operation_id = ? AND id = ?
						AND EXISTS (SELECT 1 FROM operations WHERE id = ? AND ${guard} = ?)`
					)
					.bind(
						step.state,
						step.attempt,
						msOrNull(step.startedAt),
						msOrNull(step.finishedAt),
						step.error,
						next.id,
						step.id,
						next.id,
						version
					)
			];
		});
		const update = this.db
			.prepare(
				`UPDATE operations SET status = ?, fencing_epoch = ?, rollback_point = ?, cursor = ?,
				verification = ?, final_observation = ?, updated_at = ?, version = version + 1
				WHERE id = ? AND ${guard} = ?`
			)
			.bind(
				next.status,
				next.fencingEpoch,
				next.rollbackPoint,
				next.cursor,
				next.verification,
				next.finalObservation === null ? null : JSON.stringify(next.finalObservation),
				ms(next.updatedAt),
				next.id,
				version
			);
		const results = await this.db.batch([...statements, update]);
		if (results[results.length - 1]?.meta.changes !== 1) throw new StaleWriteError(next.id);
		if (seen !== undefined) versions.set(next, seen + 1);
		return next;
	}

	async mutate(id: string, change: (operation: Operation) => Operation): Promise<Operation> {
		const current = await this.get(id);
		if (current === null) throw new OperationError('not_found', `no operation ${id}`);
		const next = change(current);
		return next === current ? current : this.save(current, next);
	}

	async runningProductionDeploys(accountId: string, excludeId: string): Promise<number> {
		const { results } = await this.db
			.prepare(
				`SELECT blast_radius FROM operations WHERE account_id = ? AND id != ?
				AND status IN (${OPEN_STATUSES.map(() => '?').join(', ')})`
			)
			.bind(accountId, excludeId, ...OPEN_STATUSES)
			.all<{ blast_radius: string }>();
		return results.reduce(
			(sum, row) => sum + (JSON.parse(row.blast_radius).productionDeploys as number),
			0
		);
	}

	async recordResource(resource: NewSiteResource, now: number): Promise<SiteResourceRow> {
		const live = (await this.liveResources(resource.siteId)).find(
			(row) => row.binding === resource.binding
		);
		if (live !== undefined) return live;
		const row: SiteResourceRow = {
			...resource,
			id: `res_${crypto.randomUUID().replaceAll('-', '')}`,
			createdByOperation: resource.createdByOperation,
			createdAt: now,
			deletedAt: null
		};
		await this.db
			.prepare(
				`INSERT INTO site_resources (id, site_id, account_id, kind, binding, name, provider_id,
				created_by_operation, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
			)
			.bind(
				row.id,
				row.siteId,
				row.accountId,
				row.kind,
				row.binding,
				row.name,
				row.providerId,
				row.createdByOperation,
				row.createdAt
			)
			.run();
		return row;
	}

	async liveResources(siteId: string): Promise<SiteResourceRow[]> {
		const { results } = await this.db
			.prepare(
				'SELECT * FROM site_resources WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid'
			)
			.bind(siteId)
			.all<ResourceRow>();
		return results.map(toResource);
	}

	async allResources(siteId: string): Promise<SiteResourceRow[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM site_resources WHERE site_id = ? ORDER BY created_at, rowid')
			.bind(siteId)
			.all<ResourceRow>();
		return results.map(toResource);
	}

	async markResourceDeleted(id: string, now: number): Promise<void> {
		await this.db
			.prepare('UPDATE site_resources SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
			.bind(now, id)
			.run();
	}

	async activateSite(site: SiteRecord, now: number): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO sites (id, organization_id, name, plane, state, account_id, category, config,
				release_id, admin_name, admin_mail, ready_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET state = 'active',
				ready_at = COALESCE(sites.ready_at, excluded.ready_at),
				release_id = COALESCE(excluded.release_id, sites.release_id),
				admin_name = COALESCE(excluded.admin_name, sites.admin_name),
				admin_mail = COALESCE(excluded.admin_mail, sites.admin_mail),
				account_id = excluded.account_id, updated_at = excluded.updated_at`
			)
			.bind(
				site.id,
				site.organizationId,
				site.name,
				site.plane,
				site.accountId,
				site.category,
				site.config,
				site.releaseId ?? null,
				site.adminName ?? null,
				site.adminMail ?? null,
				now,
				now,
				now
			)
			.run();
	}

	async setSiteRelease(siteId: string, releaseId: string, now: number): Promise<void> {
		await this.db
			.prepare('UPDATE sites SET release_id = ?, updated_at = ? WHERE id = ?')
			.bind(releaseId, now, siteId)
			.run();
	}

	async setSiteState(siteId: string, state: SiteRowState, now: number): Promise<void> {
		await this.db
			.prepare('UPDATE sites SET state = ?, updated_at = ? WHERE id = ?')
			.bind(state, now, siteId)
			.run();
	}

	async siteState(siteId: string): Promise<SiteRowState | null> {
		const row = await this.db
			.prepare('SELECT state FROM sites WHERE id = ?')
			.bind(siteId)
			.first<{ state: SiteRowState }>();
		return row === null ? null : row.state;
	}

	// oldest first, so a backlog clears in the order it formed
	async strandedCreates(failedBefore: number, limit: number): Promise<StrandedCreateRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT o.id AS operation_id, s.id AS site_id, s.account_id, s.plane, s.config,
				 s.primary_hostname FROM operations o
				 JOIN sites s ON s.id = json_extract(o.target_ids, '$[0]')
				 WHERE o.type = 'site.create' AND o.status IN ('failed', 'rolled-back', 'planned')
				 AND o.updated_at < ?
				 AND s.ready_at IS NULL AND s.state <> 'deleted'
				 ORDER BY o.updated_at LIMIT ?`
			)
			.bind(failedBefore, limit)
			.all<{
				operation_id: string;
				site_id: string;
				account_id: string | null;
				plane: SitePlane;
				config: SiteConfig;
				primary_hostname: string | null;
			}>();
		return results.map((row) => ({
			operationId: row.operation_id,
			siteId: row.site_id,
			accountId: row.account_id,
			plane: row.plane,
			config: row.config,
			hostname: row.primary_hostname
		}));
	}
}
