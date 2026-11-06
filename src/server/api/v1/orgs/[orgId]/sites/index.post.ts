import { operationSchema } from '@contracts/operations';
import { siteKind } from '@contracts/sites';
import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { createSite, siteServices } from '../../../../../services/sites';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'site.create',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Create a site',
		description:
			'Starts a site create in the organisation in the path and returns its operation. The site ID is the operation target. The site is listed once its create finishes. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.strictObject({
			kind: siteKind,
			name: z.string().min(1).max(63),
			hostnameLabel: z.string().min(1).max(63).optional()
		}),
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, body, idempotencyKey }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		if (idempotencyKey === undefined) {
			throw new ApiError('validation', 'The Idempotency-Key header is required');
		}
		const { operation } = await createSite(siteServices(), {
			orgId,
			// for a key, the person who issued it is the owner of what it creates
			userId: principal.kind === 'user' ? principal.userId : principal.issuerId,
			kind: body.kind,
			name: body.name,
			hostnameLabel: body.hostnameLabel,
			idempotencyKey
		});
		return operation;
	}
);
