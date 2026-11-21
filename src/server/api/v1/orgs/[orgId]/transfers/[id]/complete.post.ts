import { z } from 'zod';
import { transferViewSchema } from '../../../../../../../shared/agency';
import { ApiError } from '../../../../../../../shared/errors';
import { actorOf } from '../../../../../../services/delegations';
import { completeSiteTransfer, transferServices } from '../../../../../../services/transfers';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'transfer.accept',
		rateClass: 'write',
		tags: ['transfers'],
		summary: 'Complete an accepted site transfer',
		description:
			'Starts the handover of an accepted site to this organisation: its records are copied, ownership, billing and designated access change, and the routing epoch rises so an old lease cannot serve. The answer carries the operation; the transfer reads completing, then completed or failed. After a failed run, call again to start the next attempt.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		body: z.strictObject({}),
		response: transferViewSchema,
		successStatus: 202
	},
	({ principal, resource, params }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return completeSiteTransfer(transferServices(), orgId, actorOf(principal), params.id);
	}
);
