import { z } from 'zod';
import { clientListSchema } from '../../../../../../shared/agency';
import { ApiError } from '../../../../../../shared/errors';
import { clientServices, listClients } from '../../../../../services/client-workspaces';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'client.read',
		rateClass: 'read',
		tags: ['clients'],
		summary: 'List client workspaces',
		description:
			'Lists the client workspaces of this agency with the sites grouped under each one and the contacts for incidents, migrations, refunds and restores.',
		params: z.object({ orgId: z.string().min(1) }),
		response: clientListSchema
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return listClients(clientServices(), orgId);
	}
);
