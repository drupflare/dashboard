import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { connectionListSchema } from '../../../../../../shared/repo-connections';
import { listConnections, repoConnectionDeps } from '../../../../../services/repo-connections';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'repo.read',
		rateClass: 'read',
		tags: ['repos'],
		summary: 'List repository connections',
		description:
			'Lists the provider connections of the organisation in the path, active and revoked, oldest first. A connection never shows its stored credential.',
		params: z.object({ orgId: z.string().min(1) }),
		response: connectionListSchema
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		const items = await listConnections(repoConnectionDeps(), orgId);
		return { items };
	}
);
