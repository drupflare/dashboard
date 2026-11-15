import { newId, siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { moduleOperationSchema } from '../../../../../../../../shared/modules';
import { moduleServices, removeSiteModule } from '../../../../../../../services/modules';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.module.remove',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Remove a module from a site',
		description:
			'Starts removing a module and returns its operation. The site names the modules that need it first, and the removal is refused while any of them is enabled. A restore point is taken before anything changes. The site uninstalls the module first, and its files go only after that works. A module that ships with every site cannot be removed. Answers 422 with the reason while the site cannot remove modules yet. Send an Idempotency-Key header; a repeat returns the same operation.',
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
		const { operation } = await removeSiteModule(moduleServices(), {
			orgId,
			siteId: resolvedSite,
			name: body.name,
			idempotencyKey,
			operationId: newId('op')
		});
		return operation;
	}
);
