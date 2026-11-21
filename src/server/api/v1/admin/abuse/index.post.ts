import { z } from 'zod';
import { nowUtc } from '../../../../../shared/utils/time';
import { ABUSE_SOURCES } from '../../../../db/schema';
import { abuseReportView, openAbuseReport } from '../../../../services/abuse';
import { organizationServices } from '../../../../services/organizations';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.abuse.manage',
		rateClass: 'write',
		tags: ['admin'],
		summary: 'Open an abuse report on a site',
		description:
			'Records a concern about a site so it can be reviewed. The site must exist. The public report form is not part of this route.',
		body: z.strictObject({
			siteId: z.string().min(1).max(128),
			source: z.enum(ABUSE_SOURCES).default('report'),
			reason: z.string().trim().min(1).max(500)
		}),
		response: abuseReportView,
		successStatus: 201
	},
	async ({ body, principal }) => {
		if (principal === null) throw new Error('an admin route always has a principal');
		return openAbuseReport(await organizationServices().getDb(), {
			...body,
			principal,
			now: nowUtc().toMillis()
		});
	}
);
