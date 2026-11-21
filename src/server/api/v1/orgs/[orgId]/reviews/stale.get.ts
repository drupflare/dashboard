import { z } from 'zod';
import { staleReportSchema } from '../../../../../../shared/access-reviews';
import { ApiError } from '../../../../../../shared/errors';
import { staleCredentials } from '../../../../../services/access-reviews';
import { governanceServices } from '../../../../../services/governance';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'review.read',
		rateClass: 'read',
		tags: ['access-reviews'],
		summary: 'List stale credentials',
		description:
			'Lists the keys, service accounts and site grants that have not been used for 90 days. A key or account that was never used counts from the day it was made. A grant keeps no use record, so it is listed by age alone.',
		params: z.object({ orgId: z.string().min(1) }),
		response: staleReportSchema
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return staleCredentials(governanceServices(), orgId);
	}
);
