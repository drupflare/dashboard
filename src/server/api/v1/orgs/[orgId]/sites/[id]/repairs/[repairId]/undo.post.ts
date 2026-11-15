import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../../shared/errors';
import { undoSiteRepair } from '../../../../../../../../services/repairs';
import { siteServices } from '../../../../../../../../services/sites';
import { defineApi } from '../../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.repair.undo',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Undo an automatic repair',
		description:
			'Starts the undo of the repair in the path and returns its operation. The undo is itself listed in the site repairs. A repair that cannot be undone is refused with the reason. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({
			orgId: z.string().min(1),
			id: siteId,
			repairId: z.string().min(1).max(128)
		}),
		response: operationSchema,
		successStatus: 202
	},
	async ({ resource, params, idempotencyKey }) => {
		const { orgId, siteId: resolvedSite } = resource;
		if (
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
		return undoSiteRepair(siteServices(), {
			orgId,
			siteId: resolvedSite,
			repairId: params.repairId,
			idempotencyKey
		});
	}
);
