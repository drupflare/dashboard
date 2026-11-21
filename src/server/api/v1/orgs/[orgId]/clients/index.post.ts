import { z } from 'zod';
import { clientBodySchema, clientViewSchema } from '../../../../../../shared/agency';
import { ApiError } from '../../../../../../shared/errors';
import { clientServices, createClient } from '../../../../../services/client-workspaces';
import { actorOf } from '../../../../../services/delegations';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'client.manage',
		rateClass: 'write',
		tags: ['clients'],
		summary: 'Add a client workspace',
		description:
			'Adds a client to this agency. Record who the end customer contacts for incidents, migrations, refunds and restores, and any contract notes the team needs.',
		params: z.object({ orgId: z.string().min(1) }),
		body: clientBodySchema,
		response: clientViewSchema,
		successStatus: 201
	},
	({ principal, resource, params, body }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return createClient(clientServices(), orgId, actorOf(principal), body);
	}
);
