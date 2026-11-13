import { claimRequestSchema, claimResponseSchema } from '@contracts/fleet-link';
import { claimNode, fleetServices } from '../../../services/fleet';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'node.claim',
		rateClass: 'auth-code',
		tags: ['nodes'],
		summary: 'Claim a pairing from a box',
		description:
			'Takes the claim token a signed-in owner created, pins the box public key and answers with the node id, the link address and the dashboard public key. A token works once and for 15 minutes. The token is the proof, so the request carries no signature.',
		body: claimRequestSchema,
		response: claimResponseSchema,
		successStatus: 201
	},
	({ body }) => claimNode(fleetServices(), body)
);
