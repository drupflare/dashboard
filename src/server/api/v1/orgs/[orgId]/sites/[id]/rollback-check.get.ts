import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { checkRollback, rollbackCheckSchema } from '../../../../../../services/rollback-check';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.rollback',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Check whether a site can roll back its code',
		description:
			'Compares the data version of the site in the path with the release named in the release query parameter. Answers whether the code alone can go back to that release. When it cannot, the answer says why and offers restoring the data together with the code, or fixing the problem in a new release. Answers 404 when the release is not registered and 422 when it is a different kind of release than the site runs.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		query: z.object({ release: z.string().min(1).max(64) }),
		response: rollbackCheckSchema
	},
	async ({ resource, params, query }) => {
		const { orgId, siteId: resolved } = resource;
		if (
			orgId === undefined ||
			resolved === undefined ||
			orgId !== params.orgId ||
			resolved !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return checkRollback(siteServices(), { orgId, siteId: resolved, release: query.release });
	}
);
