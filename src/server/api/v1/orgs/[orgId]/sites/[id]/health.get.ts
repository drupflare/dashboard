import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { siteHealthSchema } from '../../../../../../../shared/health/view';
import { readSiteHealth, siteHealthServices } from '../../../../../../services/site-health';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Read the health of a site',
		description:
			'Reads the site live through its own hostname and returns its health tree, whether it answers, and the readiness checks. The answer is kept for 15 seconds per site. A site that does not answer is reported as not responding, not as an error. A site of another organisation is not found.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: siteHealthSchema
	},
	async ({ principal, resource, params }) => {
		const { orgId, siteId: resolvedSite } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolvedSite === undefined ||
			orgId !== params.orgId ||
			resolvedSite !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return readSiteHealth(siteHealthServices(), {
			orgId,
			siteId: resolvedSite,
			principal
		});
	}
);
