import { z } from 'zod';
import { deletedSchema } from '../../../../../../shared/agency';
import { ApiError } from '../../../../../../shared/errors';
import { clientServices, deleteClient } from '../../../../../services/client-workspaces';
import { actorOf } from '../../../../../services/delegations';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'client.manage',
		rateClass: 'write',
		tags: ['clients'],
		summary: 'Delete a client workspace',
		description:
			'Removes a client workspace and its grouping. The sites stay in the organisation and are not changed.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		response: deletedSchema
	},
	async ({ principal, resource, params }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		await deleteClient(clientServices(), orgId, actorOf(principal), params.id);
		return { deleted: true as const };
	}
);
