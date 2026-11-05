import { z } from 'zod';
import { defineApi } from '../../../../../../../../src/server/utils/define-api';
import {
	decodeCursor,
	resolveLimit,
	toPage
} from '../../../../../../../../src/server/utils/pagination';

export const MEMBER_ROWS = [
	{ id: 'mem_a1', orgId: 'org-1' },
	{ id: 'mem_a2', orgId: 'org-1' },
	{ id: 'mem_a3', orgId: 'org-1' },
	{ id: 'mem_b1', orgId: 'org-2' },
	{ id: 'mem_b2', orgId: 'org-2' },
	{ id: 'mem_b3', orgId: 'org-2' }
];

const cursorSchema = z.object({ id: z.string() });

export default defineApi(
	{
		scope: 'organization',
		action: 'member.read',
		rateClass: 'read',
		tags: ['members'],
		summary: 'List members',
		params: z.object({ orgId: z.string().min(1) }),
		query: z.object({
			limit: z.coerce.number().optional(),
			cursor: z.string().optional()
		}),
		response: z.object({
			items: z.array(z.object({ id: z.string() })),
			nextCursor: z.string().nullable()
		})
	},
	(ctx) => {
		const limit = resolveLimit(ctx.query.limit);
		const after = ctx.query.cursor ? decodeCursor(ctx.query.cursor, cursorSchema).id : '';
		const rows = MEMBER_ROWS.filter((row) => row.orgId === ctx.resource.orgId)
			.filter((row) => row.id > after)
			.slice(0, limit + 1);
		return toPage(
			rows.map((row) => ({ id: row.id })),
			limit,
			(row) => ({ id: row.id })
		);
	}
);
