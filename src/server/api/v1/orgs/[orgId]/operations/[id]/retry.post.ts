import { operationId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { authorize } from '../../../../../../domain/authorize';
import { RETRY_ACTIONS, retryOperation } from '../../../../../../services/operation-retry';
import { siteServices } from '../../../../../../services/sites';
import { defineApi, denial } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'operation.retry',
		rateClass: 'heavy',
		tags: ['operations'],
		summary: 'Retry a failed operation',
		description:
			'Starts the same work again as a new operation that carries the failed one in retryOf, and returns it. The request has no body. Only an operation that failed can be retried, and only for site creates, site updates, backups, restores and cleanups; any other type answers 422 with a plain reason. A failed create cleans up its earlier attempt first and then creates the site again under the same name. The caller needs the permission the operation was first started with. A retry that is already running or has succeeded is returned instead of starting another. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1), id: operationId }),
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, facts, idempotencyKey }) => {
		const { orgId } = resource;
		if (principal === null || orgId === undefined || orgId !== params.orgId || facts === null) {
			throw new ApiError('not_found', 'Not found');
		}
		if (idempotencyKey === undefined) {
			throw new ApiError('validation', 'The Idempotency-Key header is required');
		}
		const { operation } = await retryOperation(siteServices(), {
			orgId,
			operationId: params.id,
			// for a key, the person who issued it is the owner of what it creates
			userId: principal.kind === 'user' ? principal.userId : principal.issuerId,
			idempotencyKey,
			allow(type, siteId) {
				const action = RETRY_ACTIONS[type];
				if (action === undefined) throw new ApiError('forbidden', 'Not allowed');
				const decision = authorize({
					principal,
					action,
					resource: siteId === undefined ? { orgId } : { orgId, siteId },
					facts
				});
				if (!decision.allow) throw denial(decision);
			}
		});
		return operation;
	}
);
