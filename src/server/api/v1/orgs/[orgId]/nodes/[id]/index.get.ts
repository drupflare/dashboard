import { nodeId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { nodeViewSchema } from '../../../../../../../shared/nodes';
import { getNode } from '../../../../../../db/repos/nodes';
import { fleetServices, toNodeView } from '../../../../../../services/fleet';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'node.read',
		rateClass: 'read',
		tags: ['nodes'],
		summary: 'Read a node',
		description: 'Reads one paired node of the organisation in the path.',
		params: z.object({ orgId: z.string().min(1), id: nodeId }),
		response: nodeViewSchema
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		const node = await getNode(await fleetServices().getDb(), orgId, params.id);
		if (node === null) throw new ApiError('not_found', 'Not found');
		return toNodeView(node);
	}
);
