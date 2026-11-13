import type { OrgId, SiteId } from '@contracts/common';
import type {
	AdminPasswordState,
	Site,
	SiteCategory,
	SiteConfig,
	SiteKind,
	SitePlane
} from '@contracts/sites';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { wasChanged } from '../collegedb';

export interface SiteRecord {
	id: string;
	organizationId: string;
	name: string;
	kind: SiteKind;
	category: SiteCategory;
	plane: SitePlane;
	config: SiteConfig;
	accountId: string | null;
	state: Site['state'];
	primaryHostname: string | null;
	releaseId: string | null;
	// what the first run reported for the account it made; null on a site that predates the columns
	adminName: string | null;
	adminMail: string | null;
	// the managed site this one was adopted into, and the self-managed site this one came from
	adoptedTo: string | null;
	adoptedFrom: string | null;
	// the name the box reported when it found a site the dashboard did not create; null otherwise
	boxFoundAs: string | null;
	// when the box last stopped reporting a site that is still listed
	boxMissingSince: number | null;
	readyAt: number | null;
	createdAt: number;
	updatedAt: number;
}

interface SiteRow {
	id: string;
	organization_id: string;
	name: string;
	kind: SiteKind;
	category: SiteCategory;
	plane: SitePlane;
	config: SiteConfig;
	account_id: string | null;
	state: Site['state'];
	primary_hostname: string | null;
	release_id: string | null;
	admin_name: string | null;
	admin_mail: string | null;
	adopted_to: string | null;
	adopted_from: string | null;
	box_found_as: string | null;
	box_missing_since: number | null;
	ready_at: number | null;
	created_at: number;
	updated_at: number;
}

const SITE_COLUMNS = `id, organization_id, name, kind, category, plane, config, account_id, state,
	primary_hostname, release_id, admin_name, admin_mail, adopted_to, adopted_from, box_found_as,
	box_missing_since, ready_at, created_at, updated_at`;

function toRecord(row: SiteRow): SiteRecord {
	return {
		id: row.id,
		organizationId: row.organization_id,
		name: row.name,
		kind: row.kind,
		category: row.category,
		plane: row.plane,
		config: row.config,
		accountId: row.account_id,
		state: row.state,
		primaryHostname: row.primary_hostname,
		releaseId: row.release_id,
		adminName: row.admin_name,
		adminMail: row.admin_mail,
		adoptedTo: row.adopted_to,
		adoptedFrom: row.adopted_from,
		boxFoundAs: row.box_found_as,
		boxMissingSince: row.box_missing_since,
		readyAt: row.ready_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

// no ring or hostname list in the table yet; a new site starts in R0 with its managed host. The
// available release is the platform's current one for the site's kind, null when none is set. The
// password state comes from the pending secret, which this table does not hold
export function toSite(
	record: SiteRecord,
	available: string | null = null,
	password: AdminPasswordState = 'unknown'
): Site {
	return {
		id: record.id as SiteId,
		orgId: record.organizationId as OrgId,
		name: record.name,
		kind: record.kind,
		category: record.category,
		plane: record.plane,
		config: record.config,
		accountId: record.accountId,
		state: record.state,
		ring: 'R0',
		primaryHostname: record.primaryHostname,
		hostnames: record.primaryHostname === null ? [] : [record.primaryHostname],
		release: { current: record.releaseId, available },
		admin: { username: record.adminName, email: record.adminMail, password },
		box: {
			found: record.boxFoundAs !== null,
			missingSince:
				record.boxMissingSince === null
					? null
					: new Date(record.boxMissingSince).toISOString()
		},
		createdAt: new Date(record.createdAt).toISOString(),
		updatedAt: new Date(record.updatedAt).toISOString()
	};
}

// a site row is visible only once its create has finished (ready_at set)
export async function getReadySite(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<SiteRecord | null> {
	const row = await db.first<SiteRow>(
		organizationId,
		`SELECT ${SITE_COLUMNS} FROM sites
		 WHERE organization_id = ? AND id = ? AND ready_at IS NOT NULL`,
		[organizationId, id]
	);
	return row ? toRecord(row) : null;
}

// the row in any state, ready or not; for a site whose create never finished
export async function getSite(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<SiteRecord | null> {
	const row = await db.first<SiteRow>(
		organizationId,
		`SELECT ${SITE_COLUMNS} FROM sites WHERE organization_id = ? AND id = ?`,
		[organizationId, id]
	);
	return row ? toRecord(row) : null;
}

// returns at most count rows after the id given, and none that is tombstoned; callers ask for one
// more than the page size
export async function listReadySites(
	db: CollegeDBClient,
	organizationId: string,
	options: { after?: string; count: number }
): Promise<SiteRecord[]> {
	const { results } = await db.all<SiteRow>(
		organizationId,
		`SELECT ${SITE_COLUMNS} FROM sites
		 WHERE organization_id = ? AND ready_at IS NOT NULL AND state IN ('active', 'suspended')
		 AND id > ? ORDER BY id LIMIT ?`,
		[organizationId, options.after ?? '', options.count]
	);
	return results.map(toRecord);
}

// counts a site that can serve or whose create is running, so two quick creates cannot both pass
// a limit; a create that ended without a site stops counting before its row is cleaned up
export async function countOrganizationSites(
	db: CollegeDBClient,
	organizationId: string
): Promise<number> {
	const row = await db.first<{ n: number }>(
		organizationId,
		`SELECT COUNT(*) AS n FROM sites s
		 WHERE s.organization_id = ? AND s.state IN ('active', 'suspended')
		 AND (s.ready_at IS NOT NULL OR EXISTS (
			SELECT 1 FROM operations o WHERE o.organization_id = s.organization_id
			AND ((o.site_id = s.id AND o.type IN ('site.create', 'node.command'))
				OR (o.type = 'site.adopt' AND json_extract(o.target_ids, '$[0]') = s.id))
			AND o.status IN ('planned', 'awaiting-approval', 'running', 'verifying')))`,
		[organizationId]
	);
	return row?.n ?? 0;
}

export async function markSiteReady(
	db: CollegeDBClient,
	organizationId: string,
	id: string,
	now: number
): Promise<boolean> {
	const result = await db.run(
		organizationId,
		`UPDATE sites SET ready_at = ?, updated_at = ?
		 WHERE organization_id = ? AND id = ? AND ready_at IS NULL`,
		[now, now, organizationId, id]
	);
	return wasChanged(result);
}

export async function setSiteState(
	db: CollegeDBClient,
	organizationId: string,
	id: string,
	state: Site['state'],
	now: number
): Promise<boolean> {
	const result = await db.run(
		organizationId,
		'UPDATE sites SET state = ?, updated_at = ? WHERE organization_id = ? AND id = ?',
		[state, now, organizationId, id]
	);
	return wasChanged(result);
}

// a site of this organization that is live and ready and already holds this address, whichever
// box or way it came by
export async function findLiveSiteByHost(
	db: CollegeDBClient,
	organizationId: string,
	hostname: string
): Promise<string | null> {
	const row = await db.first<{ id: string }>(
		organizationId,
		`SELECT id FROM sites
		 WHERE organization_id = ? AND primary_hostname = ? AND ready_at IS NOT NULL
		 AND state IN ('active', 'suspended') LIMIT 1`,
		[organizationId, hostname]
	);
	return row?.id ?? null;
}

export async function siteNameTaken(
	db: CollegeDBClient,
	organizationId: string,
	name: string,
	exceptId: string
): Promise<boolean> {
	const row = await db.first<{ id: string }>(
		organizationId,
		`SELECT id FROM sites
		 WHERE organization_id = ? AND name = ? AND id <> ? AND state IN ('active', 'suspended')
		 LIMIT 1`,
		[organizationId, name, exceptId]
	);
	return row !== null;
}

// only a site the box reported on its own can be renamed this way; false when the row is not one, or
// is already gone
export async function renameFoundSite(
	db: CollegeDBClient,
	organizationId: string,
	id: string,
	name: string,
	now: number
): Promise<boolean> {
	const result = await db.run(
		organizationId,
		`UPDATE sites SET name = ?, updated_at = ?
		 WHERE organization_id = ? AND id = ? AND box_found_as IS NOT NULL
		 AND state IN ('active', 'suspended')`,
		[name, now, organizationId, id]
	);
	return wasChanged(result);
}

// a site found on a box, or one the box no longer reports, leaves the list; the row stays, deleted,
// so a box that still reports a found site is not read as a new one
export async function dropBoxSite(
	db: CollegeDBClient,
	organizationId: string,
	id: string,
	now: number
): Promise<boolean> {
	const result = await db.run(
		organizationId,
		`UPDATE sites SET state = 'deleted', updated_at = ?
		 WHERE organization_id = ? AND id = ? AND state IN ('active', 'suspended')
		 AND (box_found_as IS NOT NULL OR box_missing_since IS NOT NULL)`,
		[now, organizationId, id]
	);
	return wasChanged(result);
}
