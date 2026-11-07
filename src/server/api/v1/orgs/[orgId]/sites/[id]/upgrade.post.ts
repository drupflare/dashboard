import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { siteServices, upgradeSite } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.upgrade',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Update a site to the current release',
		description:
			"Starts an update of the site in the path to the platform's current release and returns its operation. The platform picks the target; the request has no body. The site keeps serving while the engine uploads the new release, checks the site, and puts the old release back if the check fails. Send an Idempotency-Key header; a repeat returns the same operation. Answers 409 when the site already runs the current release or another change to it is running, and 422 when the site is not live.",
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, idempotencyKey }) => {
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
		const { operation } = await upgradeSite(siteServices(), {
			orgId,
			siteId: resolved,
			idempotencyKey
		});
		return operation;
	}
);
