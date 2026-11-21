import { z } from 'zod';
import { delegationListSchema } from '../../../../../../shared/agency';
import { ApiError } from '../../../../../../shared/errors';
import { delegationServices, listDelegations } from '../../../../../services/delegations';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'delegation.read',
		rateClass: 'read',
		tags: ['delegations'],
		summary: 'List agency access',
		description:
			'Lists the agency access this organisation has given, and the access it has received as an agency. Access to several sites is one entry.',
		params: z.object({ orgId: z.string().min(1) }),
		response: delegationListSchema
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return listDelegations(delegationServices(), orgId);
	}
);
