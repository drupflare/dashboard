import { z } from 'zod';
import { listAbuseReports } from '../../../../db/repos/abuse';
import { ABUSE_STATES } from '../../../../db/schema';
import { abuseReportView } from '../../../../services/abuse';
import { organizationServices } from '../../../../services/organizations';
import { adminPageOf, adminPageQuery } from '../../../../utils/admin';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.abuse.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'List abuse reports',
		description:
			'Abuse reports newest first, optionally only those in one state. Metadata and the reviewer notes; never site content.',
		query: adminPageQuery.extend({ state: z.enum(ABUSE_STATES).optional() }),
		response: adminPageOf(abuseReportView)
	},
	async ({ query }) =>
		listAbuseReports(await organizationServices().getDb(), {
			limit: query.limit,
			...(query.before === undefined ? {} : { before: query.before }),
			...(query.state === undefined ? {} : { state: query.state })
		})
);
