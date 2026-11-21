import { breakGlassBody, breakGlassView } from '../../../../../shared/support';
import { startBreakGlass, supportServices } from '../../../../services/support';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.break-glass.start',
		rateClass: 'write',
		tags: ['admin'],
		summary: 'Start break-glass access to an organization',
		description:
			'Opens one hour of access to an organization without a support grant. Needs step-up and a written reason. Every owner of the organization is emailed at once, both audit logs record the reason, and one admin can start it only a few times a day.',
		body: breakGlassBody,
		response: breakGlassView,
		successStatus: 201
	},
	({ principal, body }) => {
		if (principal === null) throw new Error('an admin route always has a principal');
		return startBreakGlass(supportServices(), {
			orgId: body.organizationId,
			reason: body.reason,
			principal
		});
	}
);
