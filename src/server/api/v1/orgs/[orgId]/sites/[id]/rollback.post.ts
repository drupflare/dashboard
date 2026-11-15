import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { rollbackSite } from '../../../../../../services/site-rollback';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.rollback',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Roll a site back to an earlier release',
		description:
			'Puts the code of an earlier registered release back on the site and returns the operation. The data is not rolled back, so the request is refused with 422 and the offers "restore-data-with-code" and "fix-forward" when the current release changed how the site stores its data, or when the data version is unknown. Send an Idempotency-Key header; a repeat returns the same operation. Answers 409 when the site already runs that release or another change to it is running.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: z.strictObject({ release: z.string().min(1).max(128) }),
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
		const { operation } = await rollbackSite(siteServices(), {
			orgId,
			siteId: resolved,
			release: body.release,
			idempotencyKey
		});
		return operation;
	}
);
