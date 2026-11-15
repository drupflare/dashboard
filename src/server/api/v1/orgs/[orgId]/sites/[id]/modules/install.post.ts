import { newId, siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { moduleOperationSchema } from '../../../../../../../../shared/modules';
import { installSiteModule, moduleServices } from '../../../../../../../services/modules';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.module.install',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Install a module or theme on a site',
		description:
			'Starts an install of a module or theme from the list and returns its operation. The site is checked again first, and a restore point is taken before anything changes. A module that has never run on a site needs confirm set to true. A module that ships with every site, one that cannot run here, and one on no list are refused. Installing does not enable. Send an Idempotency-Key header; a repeat returns the same operation.',
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
		const { operation } = await installSiteModule(moduleServices(), {
			orgId,
			siteId: resolvedSite,
			name: body.name,
			confirm: body.confirm === true,
			idempotencyKey,
			operationId: newId('op')
		});
		return operation;
	}
);
