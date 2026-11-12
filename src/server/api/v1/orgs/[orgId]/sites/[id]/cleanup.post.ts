import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { cleanupSite, siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.cleanup',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Clean up a site that failed to create',
		description:
			'Removes what a failed create left behind for the site in the path and returns the cleanup operation, whose type is repair.run. The site must never have become active; a live site answers 409. It also answers 409 while another change to the site is running. The operation stops the site serving, deletes its script, routes and resources, frees its name and marks the site deleted. A repeat on a site that is already clean returns the operation that cleaned it. The request has no body. Send an Idempotency-Key header; a repeat returns the same operation.',
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
		const operation = await cleanupSite(siteServices(), {
			orgId,
			siteId: resolved,
			idempotencyKey
		});
		return operation.operation;
	}
);
