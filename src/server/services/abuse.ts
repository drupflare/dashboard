import type { CollegeDBClient } from '@earth-app/collegedb';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import {
	getAbuseReport,
	insertAbuseReport,
	setAbuseState,
	type AbuseReport,
	type AbuseSource,
	type AbuseState
} from '../db/repos/abuse';
import { appendPlatformAudit } from '../db/repos/platform-audit';
import { ABUSE_SOURCES, ABUSE_STATES } from '../db/schema';
import type { Principal } from '../domain/authorize';
import { organisationOfSite } from './ladder';
import { principalActor } from './owner-tokens';

export const abuseReportView = z.object({
	id: z.string(),
	siteId: z.string(),
	organizationId: z.string(),
	source: z.enum(ABUSE_SOURCES),
	reason: z.string(),
	state: z.enum(ABUSE_STATES),
	reviewer: z.string().nullable(),
	notes: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number()
});

const NEXT: Record<AbuseState, readonly AbuseState[]> = {
	open: ['reviewing', 'actioned', 'dismissed'],
	reviewing: ['open', 'actioned', 'dismissed'],
	actioned: [],
	dismissed: []
};

export async function openAbuseReport(
	db: CollegeDBClient,
	input: {
		siteId: string;
		source: AbuseSource;
		reason: string;
		principal: Principal;
		now: number;
	}
): Promise<AbuseReport> {
	const organizationId = await organisationOfSite(db, input.siteId);
	if (organizationId === null) throw new ApiError('not_found', 'No site has this id');
	const id = crypto.randomUUID();
	await appendPlatformAudit(db, {
		actor: principalActor(input.principal),
		action: 'admin.abuse.open',
		target: input.siteId,
		detail: { reportId: id, source: input.source },
		now: input.now
	});
	return insertAbuseReport(db, {
		id,
		siteId: input.siteId,
		organizationId,
		source: input.source,
		reason: input.reason,
		now: input.now
	});
}

export async function moveAbuseReport(
	db: CollegeDBClient,
	input: {
		id: string;
		state: AbuseState;
		notes: string | null;
		principal: Principal;
		now: number;
	}
): Promise<AbuseReport> {
	const report = await getAbuseReport(db, input.id);
	if (report === null) throw new ApiError('not_found', 'No abuse report has this id');
	if (!NEXT[report.state].includes(input.state)) {
		throw new ApiError('conflict', `A ${report.state} report cannot become ${input.state}`, {
			reason: 'invalid_transition'
		});
	}
	const actor = principalActor(input.principal);
	await appendPlatformAudit(db, {
		actor,
		action: 'admin.abuse.move',
		target: input.id,
		detail: { from: report.state, to: input.state },
		now: input.now
	});
	return setAbuseState(db, {
		id: input.id,
		state: input.state,
		reviewer: actor,
		notes: input.notes,
		now: input.now
	});
}
