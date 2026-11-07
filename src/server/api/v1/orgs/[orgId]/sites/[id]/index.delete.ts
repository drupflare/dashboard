import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { deleteSite, siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.delete',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Delete a site',
		description:
			"Starts the delete of the site in the path and returns its operation. The body names the site: confirm must equal the site's name. The site stops serving once the operation tombstones it, and its address is held for 90 days. Backups are kept. Send an Idempotency-Key header; a repeat returns the same operation. Answers 409 while another change to the site is running.",
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: z.strictObject({ confirm: z.string().max(256) }),
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
		const { operation } = await deleteSite(siteServices(), {
			orgId,
			siteId: resolved,
			confirm: body.confirm,
			idempotencyKey
		});
		return operation;
	}
);
