import { z } from 'zod';
import { contactBodySchema, contactViewSchema } from '../../../../../../shared/contacts';
import { ApiError } from '../../../../../../shared/errors';
import { contactServices, saveContact } from '../../../../../services/contacts';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'contact.recovery.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Set the recovery contact',
		description:
			'Sets the recovery contact. Owners only, and only after a fresh sign-in. A new address starts unverified.',
		params: z.object({ orgId: z.string().min(1) }),
		body: contactBodySchema,
		response: contactViewSchema
	},
	async ({ resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return saveContact(contactServices(), orgId, 'recovery', body);
	}
);
