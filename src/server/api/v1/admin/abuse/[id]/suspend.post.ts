import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { abuseReportView } from '../../../../../services/abuse';
import { suspendFromReport } from '../../../../../services/site-suspension';
import { supportServices } from '../../../../../services/support';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.abuse.manage',
		rateClass: 'write',
		tags: ['admin'],
		summary: 'Suspend the site of an abuse report',
		description:
			'Suspends the reported site through the site authority, tells the organization owners by email, records both audit logs and closes the report as actioned. A repeat for the same report returns the same operation. A dismissed report answers 409.',
		params: z.object({ id: z.string().min(1).max(128) }),
		response: z.object({
			report: abuseReportView,
			operation: operationSchema,
			ownersNotified: z.number()
		}),
		successStatus: 202
	},
	async ({ params, principal }) => {
		if (principal === null) throw new Error('an admin route always has a principal');
		const result = await suspendFromReport(supportServices(), {
			reportId: params.id,
			principal
		});
		return {
			report: result.report,
			operation: result.operation.operation,
			ownersNotified: result.notified
		};
	}
);
