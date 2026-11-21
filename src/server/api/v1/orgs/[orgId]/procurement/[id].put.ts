import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { procurementBodySchema, procurementViewSchema } from '../../../../../../shared/procurement';
import { procurementServices, updateProcurementRecord } from '../../../../../services/procurement';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'procurement.manage',
		rateClass: 'write',
		tags: ['procurement'],
		summary: 'Change a procurement record',
		description: 'Replaces the fields of one procurement record in the organisation.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1) }),
		body: procurementBodySchema,
		response: procurementViewSchema
	},
	async ({ resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return updateProcurementRecord(procurementServices(), orgId, params.id, body);
	}
);
