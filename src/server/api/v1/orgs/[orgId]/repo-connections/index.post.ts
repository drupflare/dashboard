import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { PROVIDER_IDS, connectStartSchema } from '../../../../../../shared/repo-connections';
import { repoConnectionDeps, startConnect } from '../../../../../services/repo-connections';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'repo.connect',
		rateClass: 'write',
		tags: ['repos'],
		summary: 'Start a repository connection',
		description:
			'GitHub and GitLab answer with a redirect address on the provider, where the person picks what to share; finish with the complete route when the provider returns. Bitbucket, Gitea and Forgejo take a read-only token and answer with the stored connection. The token is sealed and never shown again. It needs a signed-in session with a fresh sign-in, so an API key is refused.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.strictObject({
			provider: z.enum(PROVIDER_IDS),
			token: z.string().min(1).max(4096).optional(),
			baseUrl: z.string().min(1).max(2048).optional()
		}),
		response: connectStartSchema
	},
	({ principal, resource, params, body, idempotencyKey }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		// a stored reply would keep the connect address, which carries a single-use state
		if (idempotencyKey !== undefined) {
			throw new ApiError(
				'validation',
				'This request does not take an Idempotency-Key header'
			);
		}
		return startConnect(repoConnectionDeps(), { orgId, ...body });
	}
);
