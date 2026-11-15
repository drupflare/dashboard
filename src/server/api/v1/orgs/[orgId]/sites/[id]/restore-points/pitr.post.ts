import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { startPitr } from '../../../../../../../services/pitr';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.pitr.restore',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Restore a site to an earlier moment',
		description:
			'Schedules a point-in-time restore of everything the site stores. The site applies it the next time it starts. The moment must be in the past and inside the recovery window. The operation keeps an undo bookmark that returns the site to where it was. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: z.strictObject({ at: z.int().positive() }),
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
		const { operation } = await startPitr({
			orgId,
			siteId: resolved,
			at: body.at,
			idempotencyKey
		});
		return operation;
	}
);
