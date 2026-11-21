import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { clientServices, clientUsageCsv } from '../../../../../../services/client-workspaces';
import { defineApi } from '../../../../../../utils/define-api';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

export default defineApi(
	{
		scope: 'organization',
		action: 'client.read',
		rateClass: 'read',
		tags: ['clients'],
		summary: 'Export a client usage as CSV',
		description:
			'Downloads the views of each site under a client, one row per site and month, for the months given. Unaccounted hours are counted apart from views. Up to 24 months at a time.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		query: z.object({ from: month, to: month })
	},
	async ({ resource, params, query }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const csv = await clientUsageCsv(clientServices(), orgId, params.id, query);
		return new Response(csv, {
			status: 200,
			headers: {
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': `attachment; filename="client-${params.id}-usage.csv"`
			}
		});
	}
);
