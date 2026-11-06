import { z } from 'zod';
import { listUserOrganizations, type OrganizationCursor } from '../../../db/repos/organization';
import { ORGANIZATION_ROLES } from '../../../db/schema';
import type { Principal } from '../../../domain/authorize';
import { organizationServices } from '../../../services/organizations';
import { defineApi } from '../../../utils/define-api';
import { decodeCursor, resolveLimit } from '../../../utils/pagination';

const cursorShape = z.object({
	personal: z.boolean(),
	name: z.string(),
	id: z.string().min(1)
}) satisfies z.ZodType<OrganizationCursor>;

function subjectOf(principal: Principal | null): string {
	if (principal?.kind === 'key') return principal.issuerId;
	return (principal as Extract<Principal, { kind: 'user' }>).userId;
}

export default defineApi(
	{
		scope: 'session',
		action: 'account.read',
		rateClass: 'read',
		tags: ['me'],
		summary: 'List organisations',
		description:
			'Lists the organisations you belong to, the personal organisation first and then by name. A key lists the organisations of the person who issued it, and only when its scopes allow account.read.',
		query: z.object({
			cursor: z.string().optional(),
			limit: z.string().regex(/^\d+$/).optional()
		}),
		response: z.object({
			items: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					personal: z.boolean(),
					role: z.enum(ORGANIZATION_ROLES)
				})
			),
			nextCursor: z.string().nullable()
		})
	},
	async ({ principal, query }) => {
		const limit = resolveLimit(query.limit === undefined ? undefined : Number(query.limit));
		const after =
			query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorShape);
		const page = await listUserOrganizations(
			await organizationServices().getDb(),
			subjectOf(principal),
			{ after, limit }
		);
		return { items: page.items, nextCursor: page.nextCursor };
	}
);
