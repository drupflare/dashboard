import { nodeId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { siteKind } from '@contracts/sites';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { createNodeSite } from '../../../../../../services/node-site';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'node.site.create',
		rateClass: 'heavy',
		tags: ['nodes'],
		summary: 'Create a site on a node',
		description:
			'Asks a paired, connected node to add a Drupal site on a host name it will serve, and returns the operation. The box holds the request for its operator to approve, so the operation can wait. The site is listed once the box has added it. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1), id: nodeId }),
		body: z.strictObject({
			kind: siteKind,
			name: z.string().min(1).max(63),
			host: z.string().min(1).max(253)
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
		const { operation } = await createNodeSite(siteServices(), {
			orgId,
			userId: principal.kind === 'user' ? principal.userId : principal.issuerId,
			nodeId: params.id,
			kind: body.kind,
			name: body.name,
			host: body.host,
			idempotencyKey
		});
		return operation;
	}
);
