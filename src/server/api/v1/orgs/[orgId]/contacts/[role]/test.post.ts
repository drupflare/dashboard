import { z } from 'zod';
import { CONTACT_ROLES, testResultSchema } from '../../../../../../../shared/contacts';
import { ApiError } from '../../../../../../../shared/errors';
import { contactServices, sendTest } from '../../../../../../services/contacts';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'contact.test',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Send a test notification to a contact',
		description:
			'Sends one real test mail, in the operational notice category, to a verified contact that is set to receive notifications. The answer says what happened in plain words.',
		params: z.object({ orgId: z.string().min(1), role: z.enum(CONTACT_ROLES) }),
		response: testResultSchema
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return sendTest(contactServices(), orgId, params.role);
	}
);
