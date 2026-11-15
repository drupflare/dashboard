import { newId, siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { themeDefaultSchema } from '../../../../../../../../shared/modules';
import { moduleServices, setSiteThemeDefault } from '../../../../../../../services/modules';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.theme.manage',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Make a theme the default or admin theme',
		description:
			'Starts a change of the default or the admin theme of the site and returns its operation. The theme has to be enabled first. A restore point is taken before anything changes, and the site is asked afterward which theme it uses. Answers 422 with the reason while the site cannot change themes yet. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: themeDefaultSchema,
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
		const { operation } = await setSiteThemeDefault(moduleServices(), {
			orgId,
			siteId: resolvedSite,
			name: body.name,
			target: body.target,
			idempotencyKey,
			operationId: newId('op')
		});
		return operation;
	}
);
