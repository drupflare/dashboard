import { newId, siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { backupServices, startBackup } from '../../../../../../../services/backups';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'site.backup',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Back up a site',
		description:
			'Starts a backup of the site in the path and returns its operation. The dump is stored without secrets. A backup reads verified false until a scratch restore has proved it. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: z.strictObject({ label: z.string().min(1).max(100).optional() }),
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
		const { operation } = await startBackup(backupServices(), {
			orgId,
			siteId: params.id,
			label: body.label ?? null,
			idempotencyKey,
			operationId: newId('op')
		});
		return operation;
	}
);
