import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { backupIdPattern } from '../../../../../../../../../engine/src/backup-parts';
import { HOUR_MS, PREVIEW_TTL_MAX_MS } from '../../../../../../../../shared/environments';
import { ApiError } from '../../../../../../../../shared/errors';
import { actingUserId, startEnvCreate } from '../../../../../../../services/restored-copies';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.preview.manage',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Create a preview',
		description:
			'Creates a temporary copy of the site from its newest restorable backup, or from the backup named in the body. The copy is deleted when its time runs out, three days after it is made unless the body names another number of hours (at most 336). A site holds a limited number of previews at once. The copy gets its own database, files and owner token; the original is not changed. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: z.strictObject({
			backupId: z.string().regex(backupIdPattern).optional(),
			ttlHours: z
				.number()
				.int()
				.min(1)
				.max(PREVIEW_TTL_MAX_MS / HOUR_MS)
				.optional()
		}),
		response: z.object({
			environmentId: z.string(),
			ttlAt: z.number().int().nullable(),
			operation: operationSchema
		}),
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
		const { environment, operation } = await startEnvCreate({
			orgId,
			siteId: resolved,
			kind: 'preview',
			backupId: body.backupId,
			ttlMs: body.ttlHours === undefined ? undefined : body.ttlHours * HOUR_MS,
			userId: actingUserId(principal),
			idempotencyKey
		});
		return {
			environmentId: environment.id,
			ttlAt: environment.ttlAt,
			operation: operation.operation
		};
	}
);
