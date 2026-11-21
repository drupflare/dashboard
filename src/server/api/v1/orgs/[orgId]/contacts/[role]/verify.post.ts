import { z } from 'zod';
import { CONTACT_ROLES, contactViewSchema } from '../../../../../../../shared/contacts';
import { ApiError } from '../../../../../../../shared/errors';
import { contactServices, requestVerification } from '../../../../../../services/contacts';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'contact.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Send a confirmation to a contact',
		description:
			'Emails the contact a one-time link. The link lasts seven days and works once. Confirming it marks the address verified.',
		params: z.object({ orgId: z.string().min(1), role: z.enum(CONTACT_ROLES) }),
		response: contactViewSchema
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return requestVerification(contactServices(), orgId, params.role);
	}
);
