import { siteId } from '@contracts/common';
import { z } from 'zod';
import { backupIdPattern } from '../../../../../../../../../../engine/src/backup-parts';
import { ApiError } from '../../../../../../../../../shared/errors';
import { backupServices, exportBackup } from '../../../../../../../../services/backups';
import { defineApi } from '../../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'site.backup.export',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Download a backup',
		description:
			'Streams the backup as one SQL file. It needs a signed-in session, so an API key is refused. The dump carries no secrets. A backup of another organisation is not found. An audit row is written before the download starts.',
		params: z.object({
			orgId: z.string().min(1),
			siteId,
			backupId: z.string().regex(backupIdPattern)
		})
	},
	async ({ principal, resource, params }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return exportBackup(backupServices(), {
			orgId,
			siteId: params.siteId,
			backupId: params.backupId,
			principal
		});
	}
);
