import { z } from 'zod';
import { delegationCreateSchema, delegationViewSchema } from '../../../../../../shared/agency';
import { ApiError } from '../../../../../../shared/errors';
import {
	actorOf,
	createDelegationBatch,
	delegationServices
} from '../../../../../services/delegations';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'delegation.create',
		rateClass: 'write',
		tags: ['delegations'],
		summary: 'Give an agency access',
		description:
			'Offers an agency access to this organisation as a maintainer or a viewer, to chosen sites or to all sites, with an optional expiry. The agency has to accept before it can act. Nothing changes for the agency until then.',
		params: z.object({ orgId: z.string().min(1) }),
		body: delegationCreateSchema,
		response: delegationViewSchema,
		successStatus: 201
	},
	({ principal, resource, params, body }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return createDelegationBatch(delegationServices(), orgId, actorOf(principal), body);
	}
);
