import { z } from 'zod';
import { clientBodySchema, clientViewSchema } from '../../../../../../shared/agency';
import { ApiError } from '../../../../../../shared/errors';
import { clientServices, updateClient } from '../../../../../services/client-workspaces';
import { actorOf } from '../../../../../services/delegations';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'client.manage',
		rateClass: 'write',
		tags: ['clients'],
		summary: 'Change a client workspace',
		description:
			'Replaces the name, contacts and notes of a client workspace. The sites under it do not change here.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		body: clientBodySchema,
		response: clientViewSchema
	},
	({ principal, resource, params, body }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return updateClient(clientServices(), orgId, actorOf(principal), params.id, body);
	}
);
