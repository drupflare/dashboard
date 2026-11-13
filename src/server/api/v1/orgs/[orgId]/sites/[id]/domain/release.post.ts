import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import {
	domainReleaseBody,
	domainReleaseSchema,
	releaseDomain
} from '../../../../../../../services/site-domain';
import { siteServices } from '../../../../../../../services/sites';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.domain.manage',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Cancel a custom domain that is still waiting',
		description:
			'Gives up the domain in the body for the managed site in the path while it waits for the owner or is parked. A running attach stops at its next look and reads as cancelled. The name is free for any site to claim afterwards. A domain that is already set up cannot be cancelled here and answers 409. A repeat, or a domain this site does not hold, answers 200 with released false. Needs a signed-in session with a recent step-up.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: domainReleaseBody,
		response: domainReleaseSchema
	},
	async ({ principal, resource, params, body }) => {
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
		return releaseDomain(siteServices(), { orgId, siteId: resolved, hostname: body.hostname });
	}
);
