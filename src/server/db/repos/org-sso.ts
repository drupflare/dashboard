import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	SSO_CLAIM_ROLES,
	ssoRoleMapSchema,
	type SsoRole,
	type SsoRoleMap
} from '../../../shared/sso';
import { DIRECTORY_KEY, uniqueOrDuplicate, wasChanged } from '../collegedb';

export interface OrgSsoRow {
	organizationId: string;
	slug: string;
	issuer: string;
	clientId: string;
	clientSecretEnvelope: string;
	allowedDomains: string[];
	roleMap: SsoRoleMap;
	groupClaim: string;
	defaultRole: SsoRole;
	enabled: boolean;
	lastVerifiedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

interface DbRow {
	organization_id: string;
	slug: string;
	issuer: string;
	client_id: string;
	client_secret_envelope: string;
	allowed_domains: string;
	role_map: string;
	group_claim: string;
	default_role: string;
	enabled: number;
	last_verified_at: number | null;
	created_at: number;
	updated_at: number;
}

const COLUMNS = `organization_id, slug, issuer, client_id, client_secret_envelope, allowed_domains,
	role_map, group_claim, default_role, enabled, last_verified_at, created_at, updated_at`;

function parseDomains(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

function parseRoleMap(raw: string): SsoRoleMap {
	try {
		const parsed = ssoRoleMapSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}

function toRow(row: DbRow): OrgSsoRow {
	const role = SSO_CLAIM_ROLES.find((item) => item === row.default_role);
	return {
		organizationId: row.organization_id,
		slug: row.slug,
		issuer: row.issuer,
		clientId: row.client_id,
		clientSecretEnvelope: row.client_secret_envelope,
		allowedDomains: parseDomains(row.allowed_domains),
		roleMap: parseRoleMap(row.role_map),
		groupClaim: row.group_claim,
		defaultRole: role ?? 'viewer',
		enabled: row.enabled === 1,
		lastVerifiedAt: row.last_verified_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

// one row per organisation on the directory shard, so the slug is unique across organisations
export async function getOrgSso(db: CollegeDBClient, orgId: string): Promise<OrgSsoRow | null> {
	const row = await db.first<DbRow>(
		DIRECTORY_KEY,
		`SELECT ${COLUMNS} FROM org_sso WHERE organization_id = ?`,
		[orgId]
	);
	return row ? toRow(row) : null;
}

export async function getOrgSsoBySlug(
	db: CollegeDBClient,
	slug: string
): Promise<OrgSsoRow | null> {
	const row = await db.first<DbRow>(
		DIRECTORY_KEY,
		`SELECT ${COLUMNS} FROM org_sso WHERE slug = ?`,
		[slug]
	);
	return row ? toRow(row) : null;
}

export async function saveOrgSso(db: CollegeDBClient, row: OrgSsoRow): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			DIRECTORY_KEY,
			`INSERT INTO org_sso (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (organization_id) DO UPDATE SET
				slug = excluded.slug, issuer = excluded.issuer, client_id = excluded.client_id,
				client_secret_envelope = excluded.client_secret_envelope,
				allowed_domains = excluded.allowed_domains, role_map = excluded.role_map,
				group_claim = excluded.group_claim, default_role = excluded.default_role,
				enabled = excluded.enabled, last_verified_at = excluded.last_verified_at,
				updated_at = excluded.updated_at`,
			[
				row.organizationId,
				row.slug,
				row.issuer,
				row.clientId,
				row.clientSecretEnvelope,
				JSON.stringify(row.allowedDomains),
				JSON.stringify(row.roleMap),
				row.groupClaim,
				row.defaultRole,
				row.enabled ? 1 : 0,
				row.lastVerifiedAt,
				row.createdAt,
				row.updatedAt
			]
		)
	);
}

export async function markOrgSsoVerified(
	db: CollegeDBClient,
	orgId: string,
	at: number
): Promise<boolean> {
	return wasChanged(
		await db.run(
			DIRECTORY_KEY,
			'UPDATE org_sso SET last_verified_at = ?, updated_at = ? WHERE organization_id = ?',
			[at, at, orgId]
		)
	);
}
