import { nodeId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { nodeViewSchema } from '../../../../../../../shared/nodes';
import { getNode, revokeNode } from '../../../../../../db/repos/nodes';
import { fleetServices, toNodeView } from '../../../../../../services/fleet';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'node.revoke',
		rateClass: 'write',
		tags: ['nodes'],
		summary: 'Revoke a node',
		description:
			'Cuts the link to a node. The server refuses everything the node sends and sends it nothing. The box keeps running on its own, and it can be paired again with a new pairing. Revoking a node that is already revoked changes nothing.',
		params: z.object({ orgId: z.string().min(1), id: nodeId }),
		body: z.strictObject({}),
		response: nodeViewSchema
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		const services = fleetServices();
		const db = await services.getDb();
		await revokeNode(db, orgId, params.id, services.now());
		const node = await getNode(db, orgId, params.id);
		if (node === null) throw new ApiError('not_found', 'Not found');
		return toNodeView(node);
	}
);
