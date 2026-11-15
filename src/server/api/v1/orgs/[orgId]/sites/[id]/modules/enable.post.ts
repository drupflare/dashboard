import { newId, siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { moduleOperationSchema } from '../../../../../../../../shared/modules';
import { enableSiteModule, moduleServices } from '../../../../../../../services/modules';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.module.install',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Enable an installed module or theme',
		description:
			'Starts turning on a module or theme that is already on the site and returns its operation. A restore point is taken before anything changes, and the site is checked afterward. A theme is enabled the same way. A module that cannot run here and one on no list are refused. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: moduleOperationSchema,
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, body, idempotencyKey }) => {
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
		const { operation } = await enableSiteModule(moduleServices(), {
			orgId,
			siteId: resolvedSite,
			name: body.name,
			idempotencyKey,
			operationId: newId('op')
		});
		return operation;
	}
);
