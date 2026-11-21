import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { procurementViewSchema } from '../../../../../../shared/procurement';
import { listProcurementViews, procurementServices } from '../../../../../services/procurement';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'procurement.read',
		rateClass: 'read',
		tags: ['procurement'],
		summary: 'List the procurement records of an organisation',
		description:
			'Lists quotes, purchase orders, invoices and contracts, oldest first. Amounts are the text the buyer entered.',
		params: z.object({ orgId: z.string().min(1) }),
		response: z.object({ items: z.array(procurementViewSchema) })
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return { items: await listProcurementViews(procurementServices(), orgId) };
	}
);
