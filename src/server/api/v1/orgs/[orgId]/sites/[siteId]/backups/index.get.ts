import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import {
	backupServices,
	backupViewSchema,
	listSiteBackups,
	toBackupView
} from '../../../../../../../services/backups';
import { defineApi } from '../../../../../../../utils/define-api';
import { decodeCursor, resolveLimit, toPage } from '../../../../../../../utils/pagination';

const cursorShape = z.object({ createdAt: z.number().int().nonnegative(), id: z.string().min(1) });

export default defineApi(
	{
		scope: 'organization',
		action: 'site.backup',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'List the backups of a site',
		description:
			'Lists the backups of the site in the path, newest first. A backup too large for a restore says why and can still be exported.',
		params: z.object({ orgId: z.string().min(1), siteId }),
		query: z.object({
			cursor: z.string().optional(),
			limit: z.string().regex(/^\d+$/).optional()
		}),
		response: z.object({ items: z.array(backupViewSchema), nextCursor: z.string().nullable() })
	},
	async ({ resource, params, query }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const services = backupServices();
		const limit = resolveLimit(query.limit === undefined ? undefined : Number(query.limit));
		const after =
			query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorShape);
		const rows = await listSiteBackups(services, {
			orgId,
			siteId: params.siteId,
			after,
			count: limit + 1
		});
		const page = toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
		return {
			items: page.items.map((row) => toBackupView(row, services.restoreCeilingBytes)),
			nextCursor: page.nextCursor
		};
	}
);
