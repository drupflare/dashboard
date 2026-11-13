import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { domainAttachBody, startDomainAttach } from '../../../../../../../services/site-domain';
import { siteServices } from '../../../../../../../services/sites';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.domain.manage',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Attach a custom domain to a site',
		description:
			'Starts attaching the domain in the body to the managed site in the path, and returns its operation. The attach moves through four stages in order: ownership of the domain, the certificate, routing, and a final check that the site answers on the domain. It waits on the DNS records the owner adds, which the read route lists. A domain under drupflare.app or drupflare.com is refused, and so is a domain another site holds. Send an Idempotency-Key header; a repeat returns the same operation. Needs a signed-in session with a recent step-up. Answers 409 when another change to the site is running and 422 when the site is not a live managed site or the domain is not valid.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: domainAttachBody,
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, body, idempotencyKey }) => {
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
		if (idempotencyKey === undefined) {
			throw new ApiError('validation', 'The Idempotency-Key header is required');
		}
		const { operation } = await startDomainAttach(siteServices(), {
			orgId,
			siteId: resolved,
			hostname: body.hostname,
			idempotencyKey
		});
		return operation;
	}
);
