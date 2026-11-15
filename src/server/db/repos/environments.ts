import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	canMoveEnvironment,
	ENVIRONMENT_KINDS,
	isEnvironmentStatus,
	type EnvironmentKind,
	type EnvironmentStatus
} from '../../../shared/environments';
import { wasChanged } from '../collegedb';

export { ENVIRONMENT_KINDS, type EnvironmentKind, type EnvironmentStatus };

export class EnvironmentStatusError extends Error {
	constructor(
		readonly status: string,
		readonly from?: string
	) {
		super(
			from === undefined
				? `${status} is not an environment status`
				: `an environment cannot move from ${from} to ${status}`
		);
	}
}

export interface EnvironmentRecord {
	id: string;
	organizationId: string;
	siteId: string;
	kind: EnvironmentKind;
	name: string;
	host: string;
	status: EnvironmentStatus;
	// the sealed copy's own site; null until the create starts
	envSiteId: string | null;
	sourceBackupId: string | null;
	ttlAt: number | null;
	createdAt: number;
	deletedAt: number | null;
}

interface EnvironmentRow {
	id: string;
	organization_id: string;
	site_id: string;
	kind: EnvironmentKind;
	name: string;
	host: string;
	status: string;
	env_site_id: string | null;
	source_backup_id: string | null;
	ttl_at: number | null;
	created_at: number;
	deleted_at: number | null;
}

const COLUMNS = `id, organization_id, site_id, kind, name, host, status, env_site_id,
	source_backup_id, ttl_at, created_at, deleted_at`;

function toEnvironment(row: EnvironmentRow): EnvironmentRecord {
	if (!isEnvironmentStatus(row.status)) throw new EnvironmentStatusError(row.status);
	return {
		id: row.id,
		organizationId: row.organization_id,
		siteId: row.site_id,
		kind: row.kind,
		name: row.name,
		host: row.host,
		status: row.status,
		envSiteId: row.env_site_id,
		sourceBackupId: row.source_backup_id,
		ttlAt: row.ttl_at,
		createdAt: row.created_at,
		deletedAt: row.deleted_at
	};
}

export async function createEnvironment(
	db: CollegeDBClient,
	environment: Omit<EnvironmentRecord, 'deletedAt'>
): Promise<EnvironmentRecord> {
	if (!isEnvironmentStatus(environment.status)) {
		throw new EnvironmentStatusError(environment.status);
	}
	await db.run(
		environment.organizationId,
		`INSERT INTO site_environments (${COLUMNS})
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		[
			environment.id,
			environment.organizationId,
			environment.siteId,
			environment.kind,
			environment.name,
			environment.host,
			environment.status,
			environment.envSiteId,
			environment.sourceBackupId,
			environment.ttlAt,
			environment.createdAt
		]
	);
	return { ...environment, deletedAt: null };
}

export async function listEnvironments(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string
): Promise<EnvironmentRecord[]> {
	const { results } = await db.all<EnvironmentRow>(
		organizationId,
		`SELECT ${COLUMNS} FROM site_environments
		 WHERE organization_id = ? AND site_id = ? AND deleted_at IS NULL
		 ORDER BY created_at DESC, id DESC`,
		[organizationId, siteId]
	);
	return results.map(toEnvironment);
}

export async function getEnvironment(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	id: string
): Promise<EnvironmentRecord | null> {
	const row = await db.first<EnvironmentRow>(
		organizationId,
		`SELECT ${COLUMNS} FROM site_environments
		 WHERE organization_id = ? AND site_id = ? AND id = ? AND deleted_at IS NULL`,
		[organizationId, siteId, id]
	);
	return row ? toEnvironment(row) : null;
}

// moves along the allowed edges only; a repeat of the status it already has changes nothing
export async function setEnvironmentStatus(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	id: string,
	to: EnvironmentStatus,
	now: number
): Promise<boolean> {
	if (!isEnvironmentStatus(to)) throw new EnvironmentStatusError(to);
	const current = await getEnvironment(db, organizationId, siteId, id);
	if (current === null) return false;
	if (current.status === to) return false;
	if (!canMoveEnvironment(current.status, to))
		throw new EnvironmentStatusError(to, current.status);
	const result = await db.run(
		organizationId,
		`UPDATE site_environments SET status = ?, deleted_at = ?
		 WHERE organization_id = ? AND site_id = ? AND id = ? AND deleted_at IS NULL`,
		[to, to === 'deleted' ? now : null, organizationId, siteId, id]
	);
	return wasChanged(result);
}

export async function markEnvironmentDeleted(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	id: string,
	now: number
): Promise<boolean> {
	const result = await db.run(
		organizationId,
		`UPDATE site_environments SET deleted_at = ?, status = 'deleted'
		 WHERE organization_id = ? AND site_id = ? AND id = ? AND deleted_at IS NULL`,
		[now, organizationId, siteId, id]
	);
	return wasChanged(result);
}
