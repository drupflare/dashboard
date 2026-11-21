import { z } from 'zod';
import {
	CONTACT_ROLES,
	contactBodySchema,
	contactViewSchema
} from '../../../../../../shared/contacts';
import { ApiError } from '../../../../../../shared/errors';
import { contactServices, saveContact } from '../../../../../services/contacts';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'contact.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Set a technical, billing or legal contact',
		description:
			'Sets the name and address of one contact. A new address starts unverified until it is confirmed. The recovery contact has its own route, which needs step-up.',
		params: z.object({ orgId: z.string().min(1), role: z.enum(CONTACT_ROLES) }),
		body: contactBodySchema,
		response: contactViewSchema
	},
	async ({ resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		if (params.role === 'recovery') {
			throw new ApiError('validation', 'Change the recovery contact on its own route');
		}
		return saveContact(contactServices(), orgId, params.role, body);
	}
);
