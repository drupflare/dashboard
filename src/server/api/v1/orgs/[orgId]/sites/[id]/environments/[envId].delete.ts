import { environmentId, siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { startEnvDelete } from '../../../../../../../services/restored-copies';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.environment.manage',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Delete an environment',
		description:
			'Removes the environment copy and everything the platform made for it. The original site is not touched. An environment that is still being created or deleted is refused. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1), id: siteId, envId: environmentId }),
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, idempotencyKey }) => {
		const { orgId, siteId: resolved } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolved === undefined ||
			orgId !== params.orgId ||
			resolved !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		if (idempotencyKey === undefined) {
			throw new ApiError('validation', 'The Idempotency-Key header is required');
		}
		const { operation } = await startEnvDelete({
			orgId,
			siteId: resolved,
			environmentId: params.envId,
			idempotencyKey
		});
		return operation;
	}
);
