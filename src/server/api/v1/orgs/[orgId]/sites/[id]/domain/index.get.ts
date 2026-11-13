import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { domainPlanSchema, readDomain } from '../../../../../../../services/site-domain';
import { siteServices } from '../../../../../../../services/sites';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.domain.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Read the custom domains of a site',
		description:
			'Returns whether the site can take a custom domain, the domains that serve it now, and the latest attach with its four stages (ownership, certificate, routing, final check), the DNS records the owner must add and the plain reason it stopped. A site that has had no attach has no latest attach.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: domainPlanSchema
	},
	async ({ principal, resource, params }) => {
		const { orgId, siteId: resolved } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolved === undefined ||
			orgId !== params.orgId ||
			resolved !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return readDomain(siteServices(), { orgId, siteId: resolved });
	}
);
