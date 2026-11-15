import { operationSchema } from '@contracts/operations';
import { hostname, siteKind } from '@contracts/sites';
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
			'Starts a site create in the organisation in the path and returns its operation. The site ID is the operation target. The site is listed once its create finishes. A custom site takes the bundleId of a bundle the organisation uploaded and no other kind takes one. A self-managed site names a Cloudflare connection of the organisation with connectionId and runs at the account workers.dev address, or at customHost, a hostname on a zone the connection can route with that zone ID. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.strictObject({
			kind: siteKind,
			name: z.string().min(1).max(63),
			hostnameLabel: z.string().min(1).max(63).optional(),
			templateEntryId: z.string().min(1).max(40).optional(),
			bundleId: z.string().min(1).max(64).optional(),
			plane: z.enum(['managed', 'self-managed']).optional(),
			connectionId: z.string().min(1).max(64).optional(),
			customHost: z
				.strictObject({ hostname: hostname, zoneId: z.string().regex(/^[0-9a-f]{32}$/) })
				.optional()
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
			templateEntryId: body.templateEntryId,
			bundleId: body.bundleId,
			plane: body.plane,
			connectionId: body.connectionId,
			customHost: body.customHost,
			idempotencyKey
		});
		return operation;
	}
);
