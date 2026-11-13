import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { connectionViewSchema } from '../../../../../../shared/repo-connections';
import { completeConnect, repoConnectionDeps } from '../../../../../services/repo-connections';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'repo.connect',
		rateClass: 'write',
		tags: ['repos'],
		summary: 'Finish a repository connection',
		description:
			'Finishes a GitHub or GitLab connection with what the provider sent back. The state must be the one this organisation started, and it works once. For GitHub the installation must be one the signed-in person can reach on GitHub. It needs a signed-in session with a fresh sign-in, so an API key is refused.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.strictObject({
			provider: z.enum(['github', 'gitlab']),
			state: z.string().min(1).max(256),
			code: z.string().min(1).max(2048).optional(),
			installationId: z.string().min(1).max(32).optional()
		}),
		response: connectionViewSchema,
		successStatus: 201
	},
	({ principal, resource, params, body, idempotencyKey }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		// the code and the state each work once, so a stored reply could not be repeated anyway
		if (idempotencyKey !== undefined) {
			throw new ApiError(
				'validation',
				'This request does not take an Idempotency-Key header'
			);
		}
		return completeConnect(repoConnectionDeps(), { orgId, ...body });
	}
);
