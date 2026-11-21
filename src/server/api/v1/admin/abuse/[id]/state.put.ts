import { z } from 'zod';
import { nowUtc } from '../../../../../../shared/utils/time';
import { ABUSE_STATES } from '../../../../../db/schema';
import { abuseReportView, moveAbuseReport } from '../../../../../services/abuse';
import { organizationServices } from '../../../../../services/organizations';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.abuse.manage',
		rateClass: 'write',
		tags: ['admin'],
		summary: 'Move an abuse report to another state',
		description:
			'Moves a report between open, reviewing, actioned and dismissed. Actioned and dismissed are final. Answers 409 for a move the states do not allow.',
		params: z.object({ id: z.string().min(1).max(128) }),
		body: z.strictObject({
			state: z.enum(ABUSE_STATES),
			notes: z.string().trim().max(2000).nullable().default(null)
		}),
		response: abuseReportView
	},
	async ({ params, body, principal }) => {
		if (principal === null) throw new Error('an admin route always has a principal');
		return moveAbuseReport(await organizationServices().getDb(), {
			id: params.id,
			state: body.state,
			notes: body.notes,
			principal,
			now: nowUtc().toMillis()
		});
	}
);
