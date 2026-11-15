import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { backupIdPattern } from '../../../../../../../../../../engine/src/backup-parts';
import { ApiError } from '../../../../../../../../../shared/errors';
import { actingUserId, startVerify } from '../../../../../../../../services/restored-copies';
import { defineApi } from '../../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.backup.restore',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Test restore a backup',
		description:
			'Restores the backup in the path into a scratch copy, checks that the copy answers, removes the copy and marks the backup verified. The live site is not touched. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({
			orgId: z.string().min(1),
			id: siteId,
			backupId: z.string().regex(backupIdPattern)
		}),
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
		const { operation } = await startVerify({
			orgId,
			siteId: resolved,
			backupId: params.backupId,
			userId: actingUserId(principal),
			idempotencyKey
		});
		return operation;
	}
);
