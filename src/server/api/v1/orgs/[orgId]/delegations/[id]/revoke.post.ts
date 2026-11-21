import { z } from 'zod';
import { delegationViewSchema } from '../../../../../../../shared/agency';
import { ApiError } from '../../../../../../../shared/errors';
import {
	actorOf,
	delegationServices,
	revokeDelegationBatchFor
} from '../../../../../../services/delegations';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'delegation.revoke',
		rateClass: 'write',
		tags: ['delegations'],
		summary: 'End agency access',
		description:
			'Ends the agency access at once, from either side. The agency loses every action it had through the access, and both organisations keep the record. Ending access that has already ended changes nothing.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		body: z.strictObject({}),
		response: delegationViewSchema
	},
	({ principal, resource, params }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return revokeDelegationBatchFor(delegationServices(), orgId, actorOf(principal), params.id);
	}
);
