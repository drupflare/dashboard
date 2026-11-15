import { z } from 'zod';
import { listPlatformAudit, MAX_PLATFORM_AUDIT_PAGE } from '../../../../db/repos/platform-audit';
import { ladderServices } from '../../../../services/ladder';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.audit.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'Read the platform audit table',
		description:
			'Changes an administrator made that belong to no organisation, such as the global automatic repair switch, newest first. Page with the id of the last row you have.',
		query: z.object({
			limit: z.coerce.number().int().min(1).max(MAX_PLATFORM_AUDIT_PAGE).default(100),
			before: z.coerce.number().int().positive().optional()
		}),
		response: z.object({
			rows: z.array(
				z.object({
					id: z.number(),
					actor: z.string(),
					action: z.string(),
					target: z.string(),
					detail: z.unknown(),
					createdAt: z.number()
				})
			)
		})
	},
	async ({ query }) => {
		const db = await ladderServices().getDb();
		return { rows: await listPlatformAudit(db, query.limit, query.before) };
	}
);
