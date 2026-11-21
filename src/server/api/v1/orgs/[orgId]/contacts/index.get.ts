import { z } from 'zod';
import { contactViewSchema } from '../../../../../../shared/contacts';
import { ApiError } from '../../../../../../shared/errors';
import { contactServices, listContactViews } from '../../../../../services/contacts';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'contact.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'List the contacts of an organisation',
		description:
			'Lists the technical, billing, legal and recovery contacts that are set. A role with no contact is missing from the list.',
		params: z.object({ orgId: z.string().min(1) }),
		response: z.object({ items: z.array(contactViewSchema) })
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return { items: await listContactViews(contactServices(), orgId) };
	}
);
