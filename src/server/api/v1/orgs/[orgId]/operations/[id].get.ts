import { operationId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { getOperation } from '../../../../../db/repos/operations';
import { siteServices } from '../../../../../services/sites';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'operation.read',
		rateClass: 'read',
		tags: ['operations'],
		summary: 'Read an operation',
		description:
			'Returns one operation of the organisation in the path, with its steps in the order the steps run.',
		params: z.object({ orgId: z.string().min(1), id: operationId }),
		response: operationSchema
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		const stored = await getOperation(await siteServices().getDb(), orgId, params.id);
		if (!stored) throw new ApiError('not_found', 'Not found');
		return stored.operation;
	}
);
