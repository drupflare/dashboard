import { z } from 'zod';
import { transferListSchema } from '../../../../../../shared/agency';
import { ApiError } from '../../../../../../shared/errors';
import { listTransfers, transferServices } from '../../../../../services/transfers';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'transfer.read',
		rateClass: 'read',
		tags: ['transfers'],
		summary: 'List site transfers',
		description:
			'Lists the transfers this organisation proposed and the transfers waiting for its answer. A proposal that passed its window shows as expired.',
		params: z.object({ orgId: z.string().min(1) }),
		response: transferListSchema
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return listTransfers(transferServices(), orgId);
	}
);
