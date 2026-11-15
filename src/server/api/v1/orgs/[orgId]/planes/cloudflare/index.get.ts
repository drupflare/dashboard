import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { planeConnectionListSchema } from '../../../../../../../shared/plane-connections';
import {
	listPlaneConnections,
	planeConnectionDeps
} from '../../../../../../services/plane-connections';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'plane.read',
		rateClass: 'read',
		tags: ['planes'],
		summary: 'List Cloudflare connections',
		description:
			'Lists the Cloudflare accounts the organisation connected, oldest first, with each connection state, what its token can do and when it was last checked. A connection never shows its stored token.',
		params: z.object({ orgId: z.string().min(1) }),
		response: planeConnectionListSchema
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return { items: await listPlaneConnections(planeConnectionDeps(), orgId) };
	}
);
