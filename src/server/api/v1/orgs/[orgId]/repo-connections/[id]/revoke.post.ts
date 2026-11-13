import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { connectionViewSchema } from '../../../../../../../shared/repo-connections';
import { repoConnectionDeps, revokeConnection } from '../../../../../../services/repo-connections';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'repo.connect',
		rateClass: 'write',
		tags: ['repos'],
		summary: 'Revoke a repository connection',
		description:
			'Revokes the connection in the path and clears its stored credential in the same write. A second revoke answers the same view. Remotes that use it stop pulling. A GitHub installation is removed from the GitHub side in GitHub settings. It needs a signed-in session with a fresh sign-in, so an API key is refused.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		body: z.strictObject({}),
		response: connectionViewSchema
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return revokeConnection(repoConnectionDeps(), orgId, params.id);
	}
);
