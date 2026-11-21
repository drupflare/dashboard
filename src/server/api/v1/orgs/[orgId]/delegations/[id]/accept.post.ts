import { z } from 'zod';
import { delegationViewSchema } from '../../../../../../../shared/agency';
import { ApiError } from '../../../../../../../shared/errors';
import {
	acceptDelegationBatchFor,
	actorOf,
	delegationServices
} from '../../../../../../services/delegations';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'delegation.accept',
		rateClass: 'write',
		tags: ['delegations'],
		summary: 'Accept agency access',
		description:
			'Lets this agency act for the client organisation within the role and sites the client chose. The agency sees its own role limits on top of the access. Accepting twice, or after the access ended or expired, is refused.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		body: z.strictObject({}),
		response: delegationViewSchema
	},
	({ principal, resource, params }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return acceptDelegationBatchFor(delegationServices(), orgId, actorOf(principal), params.id);
	}
);
