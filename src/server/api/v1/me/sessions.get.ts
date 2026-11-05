import { z } from 'zod';
import { listSessions } from '../../../services/sessions';
import { authServices, type UserPrincipal } from '../../../utils/auth';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'read',
		tags: ['me'],
		summary: 'List sessions',
		description:
			'Lists the signed-in devices, newest first. A person holds only a handful of sessions, so the list is never paged.',
		response: z.object({
			items: z.array(
				z.object({
					id: z.string(),
					device: z.string(),
					ip: z.string().nullable(),
					createdAt: z.iso.datetime(),
					lastSeenAt: z.iso.datetime(),
					current: z.boolean()
				})
			),
			nextCursor: z.null()
		})
	},
	async ({ principal }) => {
		const { userId, sessionId } = principal as UserPrincipal;
		const sessions = await listSessions(authServices().kv, userId);
		return {
			items: sessions.map((session) => ({
				id: session.id,
				device: session.device,
				ip: session.ip,
				createdAt: new Date(session.createdAt).toISOString(),
				lastSeenAt: new Date(session.lastSeenAt).toISOString(),
				current: session.id === sessionId
			})),
			nextCursor: null
		};
	}
);
