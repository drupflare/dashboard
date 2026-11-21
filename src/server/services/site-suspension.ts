import { newId } from '@contracts/common';
import {
	planSiteAuthState,
	type SiteAuthStateInput,
	type SiteAuthStateWanted
} from '../../../engine/src/workflows/site-auth-state';
import { ApiError } from '../../shared/errors';
import { getAbuseReport, type AbuseReport } from '../db/repos/abuse';
import type { StoredOperation } from '../db/repos/operations';
import { appendPlatformAudit } from '../db/repos/platform-audit';
import { getSite } from '../db/repos/sites';
import type { Principal } from '../domain/authorize';
import { moveAbuseReport } from './abuse';
import { newOperation, startAndReturn } from './backups';
import { organisationOfSite } from './ladder';
import { principalActor } from './owner-tokens';
import type { SupportServices } from './support';

export interface SuspensionResult {
	operation: StoredOperation;
	// owners who were mailed; 0 when the call replayed an operation that already started
	notified: number;
}

const NOTICE: Record<SiteAuthStateWanted, (name: string) => string> = {
	suspended: (name) =>
		`Drupflare suspended your site ${name}. Visitors cannot reach it until the suspension is lifted. Reply to support@drupflare.com to talk it through.`,
	active: (name) =>
		`Drupflare lifted the suspension on your site ${name}. Visitors can reach it again.`
};

// the one path that changes a site's suspension from the dashboard: an operation row, one engine
// workflow, both audit trails and a security notice to the owners
export async function setSiteSuspension(
	services: SupportServices,
	input: {
		siteId: string;
		state: SiteAuthStateWanted;
		reason: SiteAuthStateInput['reason'];
		principal: Principal;
		// repeats of the same call answer the same operation
		key: string;
		reportId?: string;
	}
): Promise<SuspensionResult> {
	const db = await services.getDb();
	const now = services.now();
	const orgId = await organisationOfSite(db, input.siteId);
	if (orgId === null) throw new ApiError('not_found', 'No site has this id');
	const site = await getSite(db, orgId, input.siteId);
	if (
		site === null ||
		site.accountId === null ||
		(site.state !== 'active' && site.state !== 'suspended')
	) {
		throw new ApiError('conflict', 'This site is not live, so it cannot change suspension', {
			reason: 'site_not_live'
		});
	}
	const actor = principalActor(input.principal);
	const operationId = newId('op');
	const params: SiteAuthStateInput = {
		operationId,
		orgId,
		siteId: site.id,
		accountId: site.accountId,
		state: input.state,
		actor,
		reason: input.reason
	};
	const { operation, created } = await newOperation(db, {
		id: operationId,
		orgId,
		accountId: site.accountId,
		siteId: site.id,
		type: 'config.apply',
		plan: planSiteAuthState(params),
		idempotencyKey: `suspension:${site.id}:${input.state}:${input.key}`,
		inputs: params
	});
	if (!created) return { operation, notified: 0 };

	const action = input.state === 'suspended' ? 'admin.site.suspend' : 'admin.site.unsuspend';
	await appendPlatformAudit(db, {
		actor,
		action,
		target: site.id,
		detail: {
			operationId,
			organizationId: orgId,
			reason: input.reason,
			...(input.reportId === undefined ? {} : { reportId: input.reportId })
		},
		now
	});
	await services.audit(orgId, {
		actor,
		action: input.state === 'suspended' ? 'site.suspend' : 'site.unsuspend',
		target: site.id,
		detail: { operationId, reason: input.reason }
	});
	const started = await startAndReturn(
		services,
		db,
		operation,
		{
			workflow: 'site-auth-state',
			id: operationId,
			params: params as unknown as Record<string, unknown>
		},
		orgId
	);
	const summary = NOTICE[input.state](site.name);
	const sent = await Promise.all(
		(await services.ownerEmails(orgId)).map((to) =>
			services.notify(to, summary, `/sites/${encodeURIComponent(site.id)}`).then(
				() => 1,
				() => 0
			)
		)
	);
	return { operation: started, notified: sent.reduce<number>((a, b) => a + b, 0) };
}

// the abuse queue's "Suspend Site": suspends, then closes the report as actioned
export async function suspendFromReport(
	services: SupportServices,
	input: { reportId: string; principal: Principal }
): Promise<SuspensionResult & { report: AbuseReport }> {
	const db = await services.getDb();
	const report = await getAbuseReport(db, input.reportId);
	if (report === null) throw new ApiError('not_found', 'No abuse report has this id');
	if (report.state === 'dismissed') {
		throw new ApiError('conflict', 'A dismissed report cannot suspend a site', {
			reason: 'invalid_transition'
		});
	}
	const result = await setSiteSuspension(services, {
		siteId: report.siteId,
		state: 'suspended',
		reason: 'abuse',
		principal: input.principal,
		key: `report:${report.id}`,
		reportId: report.id
	});
	const moved =
		report.state === 'actioned'
			? report
			: await moveAbuseReport(db, {
					id: report.id,
					state: 'actioned',
					notes: report.notes ?? 'Site suspended.',
					principal: input.principal,
					now: services.now()
				});
	return { ...result, report: moved };
}
