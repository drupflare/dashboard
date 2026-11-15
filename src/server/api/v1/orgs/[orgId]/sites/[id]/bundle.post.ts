import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { siteServices, upgradeSite } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.upgrade',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Update a custom site to an uploaded bundle',
		description:
			"Starts an update of the custom site in the path to a bundle the organisation uploaded and returns its operation. The new bundle keeps the stores the site already uses and only adds migration steps; a bundle that removes or renames a class the site stores data in is refused with 422 and the reason. The site keeps serving while the engine uploads the bundle, checks the site, and puts the earlier bundle back if the check fails. An earlier bundle can be put back later with the rollback route. Send an Idempotency-Key header; a repeat returns the same operation. Answers 409 when the site already runs that bundle or another change to it is running, 422 when the site is not live or the bundle is not one of the organisation's uploads, and 403 when the plan does not include custom code.",
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: z.strictObject({ bundleId: z.string().min(1).max(64) }),
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, body, idempotencyKey }) => {
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
		const { operation } = await upgradeSite(siteServices(), {
			orgId,
			siteId: resolved,
			bundleId: body.bundleId,
			idempotencyKey
		});
		return operation;
	}
);
