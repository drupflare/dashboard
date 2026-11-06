import { newId, siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { backupIdPattern } from '../../../../../../../../../../engine/src/backup-parts';
import { ApiError } from '../../../../../../../../../shared/errors';
import { backupServices, startRestore } from '../../../../../../../../services/backups';
import { defineApi } from '../../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'site.restore',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Restore a backup into a site',
		description:
			'Starts a restore of the backup in the path into another site of the same organisation, or the same site, and returns its operation. The restore replaces the target database. A backup that is too large for a restore is refused. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({
			orgId: z.string().min(1),
			siteId,
			backupId: z.string().regex(backupIdPattern)
		}),
		body: z.strictObject({ targetSiteId: siteId }),
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, body, idempotencyKey }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		if (idempotencyKey === undefined) {
			throw new ApiError('validation', 'The Idempotency-Key header is required');
		}
		const { operation } = await startRestore(backupServices(), {
			orgId,
			siteId: params.siteId,
			backupId: params.backupId,
			targetSiteId: body.targetSiteId,
			idempotencyKey,
			operationId: newId('op')
		});
		return operation;
	}
);
