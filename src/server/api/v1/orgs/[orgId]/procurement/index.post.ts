import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { procurementBodySchema, procurementViewSchema } from '../../../../../../shared/procurement';
import { createProcurement, procurementServices } from '../../../../../services/procurement';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'procurement.manage',
		rateClass: 'write',
		tags: ['procurement'],
		summary: 'Record a procurement document',
		description:
			'Adds a quote, purchase order, invoice or contract. Nothing here computes a total or a tax.',
		params: z.object({ orgId: z.string().min(1) }),
		body: procurementBodySchema,
		response: procurementViewSchema,
		successStatus: 201
	},
	async ({ resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return createProcurement(procurementServices(), orgId, body);
	}
);
