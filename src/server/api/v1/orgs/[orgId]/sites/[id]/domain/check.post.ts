import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import {
	checkDomain,
	domainCheckBody,
	domainCheckSchema
} from '../../../../../../../services/site-domain';
import { siteServices } from '../../../../../../../services/sites';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.domain.check',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Check the DNS records for a custom domain',
		description:
			'Lists the DNS records the owner adds for the domain in the body and reads each one live, without starting an attach. Each record is found, not found yet, found with a different value, or could not be checked right now; a DNS lookup that fails is never reported as a missing record. The answer also lists hazards: an alias record on a bare domain, other records that point the name elsewhere, CAA records that block the certificate, and a second ownership value. A domain under drupflare.app or drupflare.com is refused, and so is a wildcard. A domain another site holds comes back with held set and no records. Needs a signed-in session. Answers 422 when the site is not a live managed site or the domain is not valid.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: domainCheckBody,
		response: domainCheckSchema
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
		return checkDomain(siteServices(), { orgId, siteId: resolved, hostname: body.hostname });
	}
);
