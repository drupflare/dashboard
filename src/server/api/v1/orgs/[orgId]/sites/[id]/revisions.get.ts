import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { listRevisions, revisionListSchema } from '../../../../../../services/rollback-check';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'List the code history of a site',
		description:
			'Lists the releases the site has run, newest first, up to 50. Each row carries the release id and version, a note when the revision is an edit, and whether it is the code the site runs now. A site of another organisation is not found.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: revisionListSchema
	},
	async ({ resource, params }) => {
		const { orgId, siteId: resolved } = resource;
		if (
			orgId === undefined ||
			resolved === undefined ||
			orgId !== params.orgId ||
			resolved !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return listRevisions(siteServices(), { orgId, siteId: resolved });
	}
);
