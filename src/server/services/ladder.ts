import type { CollegeDBClient } from '@earth-app/collegedb';
import { REPAIR_HANDLES } from '../../../engine/src/repair/handles';
import type { LadderScope } from '../../../engine/src/repair/rows';
import { ApiError } from '../../shared/errors';
import { CATALOGUE_ROWS, type CatalogueRow } from '../../shared/health/catalogue';
import { GLOBAL_CONFIRMATION } from '../../shared/health/repair-copy';
import { DIRECTORY_KEY } from '../db/collegedb';
import { GLOBAL_SCOPE_ID, setLadderSwitch } from '../db/repos/ladder-switches';
import { getOrganization } from '../db/repos/organization';
import { appendPlatformAudit } from '../db/repos/platform-audit';
import type { Principal } from '../domain/authorize';
import type { AuditInput } from './audit';
import { principalActor } from './owner-tokens';

export interface LadderServices {
	getDb: () => Promise<CollegeDBClient>;
	// writes to an organisation's audit chain; a global change goes to the platform audit table
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	now: () => number;
}

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

let installed: LadderServices | null = null;

export function setLadderServices(services: LadderServices | null): void {
	installed = services;
}

export function ladderServices(): LadderServices {
	if (installed === null) {
		return {
			getDb: notBuilt('The ladder store'),
			audit: notBuilt('The audit log'),
			now: () => Date.now()
		};
	}
	return installed;
}

export interface LadderRowView {
	repairId: string;
	source: string;
	severity: CatalogueRow['severity'];
	handle: string;
	automation: CatalogueRow['automation'];
	canRunToday: boolean;
	reason: string | null;
}

// the reason is for an admin, so it names the missing piece; an owner never sees this text
export function ladderRowView(row: CatalogueRow): LadderRowView {
	const handler = REPAIR_HANDLES[row.repairId];
	const automatic = row.automation === 'auto' || row.automation === 'auto-with-guard';
	if (!automatic) {
		return {
			repairId: row.repairId,
			source: row.source,
			severity: row.severity,
			handle: row.handle,
			automation: row.automation,
			canRunToday: false,
			reason:
				row.automation === 'approval'
					? 'A person must approve this repair. Automatic repair does not run it.'
					: 'Only a person can run this repair. Automatic repair does not run it.'
		};
	}
	const verified = handler?.verified === true;
	return {
		repairId: row.repairId,
		source: row.source,
		severity: row.severity,
		handle: row.handle,
		automation: row.automation,
		canRunToday: verified,
		reason: verified
			? null
			: 'No route on the site worker for this repair yet. It refuses to run.'
	};
}

export const listLadderRows = (): LadderRowView[] => CATALOGUE_ROWS.map(ladderRowView);

export interface SwitchView {
	scope: LadderScope;
	scopeId: string;
	auto: boolean;
	updatedAt: number;
}

export async function listSwitches(db: CollegeDBClient): Promise<SwitchView[]> {
	const { results } = await db.all<{
		scope: LadderScope;
		scope_id: string;
		auto: number;
		updated_at: number;
	}>(
		DIRECTORY_KEY,
		'SELECT scope, scope_id, auto, updated_at FROM ladder_switches ORDER BY scope, scope_id',
		[]
	);
	return results.map((row) => ({
		scope: row.scope,
		scopeId: row.scope_id,
		auto: row.auto === 1,
		updatedAt: row.updated_at
	}));
}

// the site's organisation is found across shards, because the admin names only the site
async function organisationOfSite(db: CollegeDBClient, siteId: string): Promise<string | null> {
	const shards = await db.allAllShards<{ organization_id: string }>(
		'SELECT organization_id FROM sites WHERE id = ?',
		[siteId]
	);
	for (const shard of shards) {
		if (!shard.success)
			throw new ApiError('internal', 'A shard failed while looking up the site');
		const [row] = shard.results;
		if (row) return row.organization_id;
	}
	return null;
}

const refuse = (reason: string, message: string) =>
	new ApiError('unprocessable', message, { reason });

export async function setSwitch(
	services: LadderServices,
	input: {
		scope: LadderScope;
		scopeId: string;
		auto: boolean;
		confirmation?: string;
		principal: Principal;
	}
): Promise<SwitchView> {
	const db = await services.getDb();
	const now = services.now();
	const actor = principalActor(input.principal);
	let auditOrg: string | null = null;
	if (input.scope === 'global') {
		if (input.scopeId !== GLOBAL_SCOPE_ID) {
			throw refuse('unknown_scope', 'The global switch takes no scope id');
		}
		if (input.confirmation !== GLOBAL_CONFIRMATION) {
			throw refuse(
				'confirmation_required',
				`Type ${GLOBAL_CONFIRMATION} to change the global switch`
			);
		}
	} else {
		if (input.scopeId === '') throw refuse('unknown_scope', 'This switch needs a scope id');
		if (input.scope === 'organization') {
			if ((await getOrganization(db, input.scopeId)) === null) {
				throw refuse('unknown_scope', 'No organization has this id');
			}
			auditOrg = input.scopeId;
		} else {
			auditOrg = await organisationOfSite(db, input.scopeId);
			if (auditOrg === null) throw refuse('unknown_scope', 'No site has this id');
		}
	}
	const target = input.scopeId === '' ? input.scope : input.scopeId;
	const detail = { scope: input.scope, auto: input.auto };
	if (auditOrg !== null) {
		await services.audit(auditOrg, { actor, action: 'admin.ladder.switch', target, detail });
	} else {
		await appendPlatformAudit(db, {
			actor,
			action: 'admin.ladder.switch',
			target,
			detail,
			now
		});
	}
	await setLadderSwitch(db, {
		scope: input.scope,
		scopeId: input.scopeId,
		auto: input.auto,
		updatedBy: actor,
		now
	});
	return { scope: input.scope, scopeId: input.scopeId, auto: input.auto, updatedAt: now };
}
