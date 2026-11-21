import type { UsageInterval } from '@contracts/usage';
import type { CollegeDBClient } from '@earth-app/collegedb';
import type { ClientBody, ClientView } from '../../shared/agency';
import { ApiError } from '../../shared/errors';
import { DuplicateRowError } from '../db/collegedb';
import {
	addWorkspaceSite,
	deleteWorkspace,
	getWorkspace,
	insertWorkspace,
	listWorkspaceSites,
	listWorkspaces,
	removeWorkspaceSite,
	updateWorkspace,
	type ClientWorkspaceRecord
} from '../db/repos/agency';
import { getSite } from '../db/repos/sites';
import type { Principal } from '../domain/authorize';
import { monthSpan, monthlyUsage, nextMonth, usageCsv } from '../domain/client-usage';
import type { AuditInput } from './audit';
import { principalActor } from './owner-tokens';

export type UsageSampleRead = (input: {
	orgId: string;
	siteIds: readonly string[];
	from: string;
	to: string;
}) => Promise<Pick<UsageInterval, 'siteId' | 'start' | 'accuracy' | 'views' | 'lowerBound'>[]>;

export interface ClientServices {
	getDb: () => Promise<CollegeDBClient>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	now: () => number;
	// the settled hourly usage of the given sites; absent until a per-site read is built
	usage?: UsageSampleRead;
}

let installed: ClientServices | null = null;

export function setClientServices(services: ClientServices | null): void {
	installed = services;
}

export function clientServices(): ClientServices {
	if (installed === null)
		throw new ApiError('not_built', 'Client workspaces are not available yet');
	return installed;
}

export interface ClientActor {
	principal: Principal;
	userId: string;
}

const GONE_SITE_STATES = ['tombstoned', 'purge-eligible', 'deleted'];
const MAX_EXPORT_MONTHS = 24;

function view(record: ClientWorkspaceRecord, siteIds: readonly string[]): ClientView {
	return {
		id: record.id,
		name: record.name,
		contactName: record.contactName,
		contactEmail: record.contactEmail,
		notes: record.notes,
		contractNotes: record.contractNotes,
		siteIds: [...siteIds],
		createdAt: new Date(record.createdAt).toISOString(),
		updatedAt: new Date(record.updatedAt).toISOString()
	};
}

async function siteIdsByWorkspace(
	db: CollegeDBClient,
	orgId: string
): Promise<Map<string, string[]>> {
	const map = new Map<string, string[]>();
	for (const row of await listWorkspaceSites(db, orgId)) {
		const ids = map.get(row.workspaceId) ?? [];
		ids.push(row.siteId);
		map.set(row.workspaceId, ids);
	}
	return map;
}

async function audit(
	deps: ClientServices,
	orgId: string,
	actor: ClientActor,
	action: string,
	target: string,
	detail: Record<string, unknown> = {}
): Promise<void> {
	await deps.audit(orgId, { actor: principalActor(actor.principal), action, target, detail });
}

async function liveWorkspace(
	db: CollegeDBClient,
	orgId: string,
	id: string
): Promise<ClientWorkspaceRecord> {
	const record = await getWorkspace(db, orgId, id);
	if (record === null) throw new ApiError('not_found', 'Not found');
	return record;
}

export async function listClients(
	deps: ClientServices,
	orgId: string
): Promise<{ items: ClientView[] }> {
	const db = await deps.getDb();
	const [records, sites] = await Promise.all([
		listWorkspaces(db, orgId),
		siteIdsByWorkspace(db, orgId)
	]);
	return { items: records.map((record) => view(record, sites.get(record.id) ?? [])) };
}

export async function createClient(
	deps: ClientServices,
	orgId: string,
	actor: ClientActor,
	body: ClientBody
): Promise<ClientView> {
	const db = await deps.getDb();
	const now = deps.now();
	const record: ClientWorkspaceRecord = {
		id: crypto.randomUUID(),
		organizationId: orgId,
		name: body.name,
		contactName: body.contactName ?? null,
		contactEmail: body.contactEmail ?? null,
		notes: body.notes ?? null,
		contractNotes: body.contractNotes ?? null,
		createdAt: now,
		updatedAt: now
	};
	await insertWorkspace(db, record);
	await audit(deps, orgId, actor, 'client.created', record.id);
	return view(record, []);
}

export async function updateClient(
	deps: ClientServices,
	orgId: string,
	actor: ClientActor,
	id: string,
	body: ClientBody
): Promise<ClientView> {
	const db = await deps.getDb();
	const current = await liveWorkspace(db, orgId, id);
	const record: ClientWorkspaceRecord = {
		...current,
		name: body.name,
		contactName: body.contactName ?? null,
		contactEmail: body.contactEmail ?? null,
		notes: body.notes ?? null,
		contractNotes: body.contractNotes ?? null,
		updatedAt: deps.now()
	};
	await updateWorkspace(db, record);
	await audit(deps, orgId, actor, 'client.updated', id);
	const sites = await siteIdsByWorkspace(db, orgId);
	return view(record, sites.get(id) ?? []);
}

export async function deleteClient(
	deps: ClientServices,
	orgId: string,
	actor: ClientActor,
	id: string
): Promise<void> {
	const db = await deps.getDb();
	await liveWorkspace(db, orgId, id);
	await deleteWorkspace(db, orgId, id);
	await audit(deps, orgId, actor, 'client.deleted', id);
}

// a site under one client cannot be added to another; the write answers with the conflict
export async function addClientSite(
	deps: ClientServices,
	orgId: string,
	actor: ClientActor,
	id: string,
	siteId: string
): Promise<ClientView> {
	const db = await deps.getDb();
	const record = await liveWorkspace(db, orgId, id);
	const site = await getSite(db, orgId, siteId);
	if (site === null || GONE_SITE_STATES.includes(site.state)) {
		throw new ApiError('unprocessable', 'That site is not in this organisation', {
			reason: 'site_not_found'
		});
	}
	try {
		await addWorkspaceSite(db, orgId, id, siteId, deps.now());
	} catch (error) {
		if (error instanceof DuplicateRowError) {
			throw new ApiError('conflict', 'That site already belongs to a client', {
				reason: 'site_grouped'
			});
		}
		throw error;
	}
	await audit(deps, orgId, actor, 'client.site.added', id, { siteId });
	const sites = await siteIdsByWorkspace(db, orgId);
	return view(record, sites.get(id) ?? []);
}

export async function removeClientSite(
	deps: ClientServices,
	orgId: string,
	actor: ClientActor,
	id: string,
	siteId: string
): Promise<void> {
	const db = await deps.getDb();
	await liveWorkspace(db, orgId, id);
	if (!(await removeWorkspaceSite(db, orgId, id, siteId))) {
		throw new ApiError('not_found', 'Not found');
	}
	await audit(deps, orgId, actor, 'client.site.removed', id, { siteId });
}

// months are YYYY-MM and the range is inclusive; the export reads the sites the client holds now
export async function clientUsageCsv(
	deps: ClientServices,
	orgId: string,
	id: string,
	range: { from: string; to: string }
): Promise<string> {
	const months = monthSpan(range.from, range.to);
	if (months === null || months > MAX_EXPORT_MONTHS) {
		throw new ApiError('validation', `Choose a range of up to ${MAX_EXPORT_MONTHS} months`, {
			reason: 'bad_range'
		});
	}
	if (!deps.usage) {
		throw new ApiError('not_built', 'Usage exports are not available yet', {
			reason: 'usage_read_not_built'
		});
	}
	const db = await deps.getDb();
	await liveWorkspace(db, orgId, id);
	const sites = (await siteIdsByWorkspace(db, orgId)).get(id) ?? [];
	const from = `${range.from}-01T00:00:00.000Z`;
	const to = `${nextMonth(range.to)}-01T00:00:00.000Z`;
	const samples = sites.length === 0 ? [] : await deps.usage({ orgId, siteIds: sites, from, to });
	return usageCsv(monthlyUsage(samples));
}
