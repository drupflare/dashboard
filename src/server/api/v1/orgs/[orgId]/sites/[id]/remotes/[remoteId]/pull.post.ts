import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../../shared/errors';
import { pullNow, repoConnectionDeps } from '../../../../../../../../services/repo-connections';
import { defineApi } from '../../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.remote.manage',
		rateClass: 'heavy',
		tags: ['repos'],
		summary: 'Pull a repository onto a site',
		description:
			'Starts a pull of the attached repository onto the site in the path and returns its operation. The result is written on the remote as its last pull. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({
			orgId: z.string().min(1),
			id: siteId,
			remoteId: z.string().min(1).max(64)
		}),
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, idempotencyKey }) => {
		const { orgId, siteId: resolvedSite } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolvedSite === undefined ||
			orgId !== params.orgId ||
			resolvedSite !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		if (idempotencyKey === undefined) {
			throw new ApiError('validation', 'The Idempotency-Key header is required');
		}
		const operation = await pullNow(repoConnectionDeps(), {
			orgId,
			siteId: resolvedSite,
			remoteId: params.remoteId,
			idempotencyKey
		});
		return operation.operation;
	}
);
