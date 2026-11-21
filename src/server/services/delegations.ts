import type { CollegeDBClient } from '@earth-app/collegedb';
import type { DelegationCreate, DelegationList, DelegationView } from '../../shared/agency';
import { ApiError } from '../../shared/errors';
import {
	acceptDelegationBatch,
	findDelegationBatch,
	listDelegationsReceived,
	listDelegationsSent,
	revokeDelegationBatch
} from '../db/repos/agency';
import {
	getOrganization,
	createDelegation as insertDelegation,
	type Delegation as Row
} from '../db/repos/organization';
import { getSite } from '../db/repos/sites';
import type { Principal } from '../domain/authorize';
import {
	acceptDelegation,
	createDelegation,
	revokeDelegation,
	type Delegation,
	type DelegationError
} from '../domain/delegation';
import type { AuditInput } from './audit';
import { principalActor } from './owner-tokens';

export interface DelegationServices {
	getDb: () => Promise<CollegeDBClient>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	now: () => number;
}

let installed: DelegationServices | null = null;

export function setDelegationServices(services: DelegationServices | null): void {
	installed = services;
}

export function delegationServices(): DelegationServices {
	if (installed === null) throw new ApiError('not_built', 'Agency access is not available yet');
	return installed;
}

export interface DelegationActor {
	principal: Principal;
	userId: string;
}

// a key acts for the person who issued it, the same as every subject fact
export function actorOf(principal: Principal): DelegationActor {
	return {
		principal,
		userId: principal.kind === 'user' ? principal.userId : principal.issuerId
	};
}

const GONE_SITE_STATES = ['tombstoned', 'purge-eligible', 'deleted'];

function mapError(reason: DelegationError): ApiError {
	switch (reason) {
		case 'same_org':
			return new ApiError('unprocessable', 'Choose a different organisation as the agency', {
				reason
			});
		case 'bad_role':
		case 'no_sites':
			return new ApiError('validation', 'Choose a role and at least one site', { reason });
		case 'bad_expiry':
			return new ApiError('validation', 'Choose an expiry date in the future', { reason });
		case 'not_pending':
			return new ApiError('conflict', 'This access is no longer waiting for an answer', {
				reason
			});
		case 'expired':
			return new ApiError('conflict', 'This access has expired and cannot be accepted', {
				reason
			});
		case 'already_revoked':
			return new ApiError('conflict', 'This access has already ended', { reason });
		case 'wrong_side':
			return new ApiError('forbidden', 'Only the agency can accept this access', { reason });
		case 'not_party':
			return new ApiError('not_found', 'Not found');
	}
}

// the rows of one delegation share a batch id; the view state is the first row's, all rows move together
function viewState(rows: readonly Row[], now: number): DelegationView['state'] {
	const first = rows[0] as Row;
	if (first.state === 'revoked') return 'revoked';
	if (first.expiresAt !== null && now >= first.expiresAt) return 'expired';
	return first.state;
}

function batchView(rows: readonly Row[], now: number): DelegationView {
	const first = rows[0] as Row;
	const everySite = rows.some((row) => row.siteId === null);
	return {
		id: first.batchId,
		clientOrganizationId: first.organizationId,
		agencyOrganizationId: first.agencyOrganizationId,
		role: first.role,
		sites: everySite ? 'all' : rows.map((row) => row.siteId as string),
		state: viewState(rows, now),
		createdBy: first.createdBy,
		createdAt: new Date(first.createdAt).toISOString(),
		expiresAt: first.expiresAt === null ? null : new Date(first.expiresAt).toISOString(),
		revokedAt: first.revokedAt === null ? null : new Date(first.revokedAt).toISOString()
	};
}

function groupBatches(rows: readonly Row[], now: number): DelegationView[] {
	const batches = new Map<string, Row[]>();
	for (const row of rows) {
		const batch = batches.get(row.batchId) ?? [];
		batch.push(row);
		batches.set(row.batchId, batch);
	}
	return [...batches.values()].map((batch) => batchView(batch, now));
}

// the domain works on one delegation per batch; a batch of site rows is that delegation's site list
function asDomain(rows: readonly Row[]): Delegation {
	const first = rows[0] as Row;
	const everySite = rows.some((row) => row.siteId === null);
	return {
		id: first.batchId,
		clientOrgId: first.organizationId,
		agencyOrgId: first.agencyOrganizationId,
		role: first.role,
		sites: everySite ? 'all' : rows.map((row) => row.siteId as string),
		status: first.state,
		createdBy: first.createdBy,
		createdAt: first.createdAt,
		...(first.expiresAt === null ? {} : { expiresAt: first.expiresAt })
	};
}

async function auditBoth(
	deps: DelegationServices,
	rows: readonly Row[],
	actor: DelegationActor,
	action: string,
	detail: Record<string, unknown>
): Promise<void> {
	const first = rows[0] as Row;
	const input = {
		actor: principalActor(actor.principal),
		action,
		target: first.batchId,
		detail
	};
	await deps.audit(first.organizationId, input);
	await deps.audit(first.agencyOrganizationId, input);
}

export async function listDelegations(
	deps: DelegationServices,
	orgId: string
): Promise<DelegationList> {
	const db = await deps.getDb();
	const now = deps.now();
	const [sent, received] = await Promise.all([
		listDelegationsSent(db, orgId),
		listDelegationsReceived(db, orgId)
	]);
	return { sent: groupBatches(sent, now), received: groupBatches(received, now) };
}

// a site that is gone or not in the client organisation is refused the same way
export async function createDelegationBatch(
	deps: DelegationServices,
	clientOrgId: string,
	actor: DelegationActor,
	body: DelegationCreate
): Promise<DelegationView> {
	const db = await deps.getDb();
	const now = deps.now();
	const sites = body.sites;
	if (sites !== 'all') {
		for (const id of sites) {
			const site = await getSite(db, clientOrgId, id);
			if (site === null || GONE_SITE_STATES.includes(site.state)) {
				throw new ApiError(
					'unprocessable',
					'One of those sites is not in this organisation',
					{
						reason: 'site_not_found'
					}
				);
			}
		}
	}
	if (body.agencyOrganizationId !== clientOrgId) {
		const agency = await getOrganization(db, body.agencyOrganizationId);
		if (agency === null) {
			throw new ApiError('unprocessable', 'That organisation cannot take this access', {
				reason: 'agency_unknown'
			});
		}
	}
	const expiresAt = body.expiresAt ? Date.parse(body.expiresAt) : null;
	const checked = createDelegation({
		id: 'batch',
		clientOrgId,
		agencyOrgId: body.agencyOrganizationId,
		role: body.role,
		sites,
		createdBy: actor.userId,
		now,
		...(expiresAt === null ? {} : { expiresAt })
	});
	if (!checked.ok) throw mapError(checked.reason);

	const batchId = crypto.randomUUID();
	const targets: (string | null)[] = sites === 'all' ? [null] : sites;
	const rows: Row[] = [];
	for (const siteId of targets) {
		rows.push(
			await insertDelegation(db, clientOrgId, {
				agencyOrganizationId: body.agencyOrganizationId,
				role: body.role,
				siteId,
				createdBy: actor.userId,
				expiresAt,
				batchId
			})
		);
	}
	await auditBoth(deps, rows, actor, 'delegation.created', {
		role: body.role,
		sites: sites === 'all' ? 'all' : sites.length
	});
	return batchView(rows, now);
}

// the agency answers; the batch moves in one write, and a second answer finds it no longer pending
export async function acceptDelegationBatchFor(
	deps: DelegationServices,
	agencyOrgId: string,
	actor: DelegationActor,
	batchId: string
): Promise<DelegationView> {
	const db = await deps.getDb();
	const now = deps.now();
	const rows = (await findDelegationBatch(db, batchId)).filter(
		(row) => row.agencyOrganizationId === agencyOrgId
	);
	if (rows.length === 0) throw new ApiError('not_found', 'Not found');
	const answer = acceptDelegation(asDomain(rows), { orgId: agencyOrgId, now });
	if (!answer.ok) throw mapError(answer.reason);
	const first = rows[0] as Row;
	const moved = await acceptDelegationBatch(db, first.organizationId, batchId, actor.userId, now);
	if (!moved) throw mapError('not_pending');
	const active = rows.map((row) => ({ ...row, state: 'active' as const, updatedAt: now }));
	await auditBoth(deps, active, actor, 'delegation.accepted', {});
	return batchView(active, now);
}

// either side ends the access; ending an ended one changes nothing and returns the batch as it is
export async function revokeDelegationBatchFor(
	deps: DelegationServices,
	orgId: string,
	actor: DelegationActor,
	batchId: string
): Promise<DelegationView> {
	const db = await deps.getDb();
	const now = deps.now();
	const rows = (await findDelegationBatch(db, batchId)).filter(
		(row) => row.organizationId === orgId || row.agencyOrganizationId === orgId
	);
	if (rows.length === 0) throw new ApiError('not_found', 'Not found');
	const answer = revokeDelegation(asDomain(rows), { orgId, now });
	if (!answer.ok) {
		if (answer.reason === 'already_revoked') return batchView(rows, now);
		throw mapError(answer.reason);
	}
	const first = rows[0] as Row;
	await revokeDelegationBatch(db, first.organizationId, batchId, now);
	const ended = rows.map((row) => ({
		...row,
		state: 'revoked' as const,
		revokedAt: now,
		updatedAt: now
	}));
	await auditBoth(deps, ended, actor, 'delegation.revoked', {
		by: orgId === first.organizationId ? 'client' : 'agency'
	});
	return batchView(ended, now);
}
