import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { pairingViewSchema } from '../../../../../../shared/nodes';
import { fleetServices, startPairing } from '../../../../../services/fleet';
import { principalActor } from '../../../../../services/owner-tokens';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'node.pair',
		rateClass: 'heavy',
		tags: ['nodes'],
		summary: 'Start pairing a node',
		description:
			'Creates a pairing that lasts 15 minutes and returns its claim token once. Run bastion pair with the address on the box. It needs a signed-in session with a fresh sign-in, so an API key is refused.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.strictObject({}),
		response: pairingViewSchema,
		successStatus: 201
	},
	({ principal, resource, params, idempotencyKey }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		// a stored reply would keep the claim token at rest
		if (idempotencyKey !== undefined) {
			throw new ApiError(
				'validation',
				'This request does not take an Idempotency-Key header'
			);
		}
		return startPairing(fleetServices(), { orgId, actor: principalActor(principal) });
	}
);
