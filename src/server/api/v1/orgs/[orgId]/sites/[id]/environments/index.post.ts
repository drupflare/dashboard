import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { backupIdPattern } from '../../../../../../../../../engine/src/backup-parts';
import { ENVIRONMENT_KINDS } from '../../../../../../../../shared/environments';
import { ApiError } from '../../../../../../../../shared/errors';
import { actingUserId, startEnvCreate } from '../../../../../../../services/restored-copies';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.environment.manage',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Create an environment',
		description:
			'Creates a staging or dev copy of the site from its newest restorable backup, or from the backup named in the body. The copy gets its own database and files and its own owner token; the original is not changed. Settings and secrets stay behind and must be set again on the copy. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: z.strictObject({
			kind: z.enum(
				ENVIRONMENT_KINDS.filter((kind) => kind !== 'preview') as ['staging', 'dev']
			),
			backupId: z.string().regex(backupIdPattern).optional()
		}),
		response: z.object({ environmentId: z.string(), operation: operationSchema }),
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
			kind: body.kind,
			backupId: body.backupId,
			userId: actingUserId(principal),
			idempotencyKey
		});
		return { environmentId: environment.id, operation: operation.operation };
	}
);
