import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { repoListSchema } from '../../../../../../../shared/repo-connections';
import { listRepositories, repoConnectionDeps } from '../../../../../../services/repo-connections';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'repo.read',
		rateClass: 'heavy',
		tags: ['repos'],
		summary: 'List the repositories of a connection',
		description:
			'Asks the provider which repositories the connection can read, up to 100. A GitHub installation lists only the repositories it was installed on. A revoked connection is refused.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		response: repoListSchema
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return { items: await listRepositories(repoConnectionDeps(), orgId, params.id) };
	}
);
