import { z } from 'zod';
import { ApiError } from '../../../../shared/errors';
import { PLATFORM_ROLES } from '../../../../shared/permissions';
import { stepUpUntil } from '../../../services/auth';
import { authServices, stepUpAtOf } from '../../../utils/auth';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.read',
		rateClass: 'read',
		tags: ['me'],
		summary: 'Read the signed-in account',
		description:
			'Returns the account behind the session or, for an API key, the account that issued it.',
		response: z.object({
			id: z.string(),
			email: z.string(),
			displayName: z.string().nullable(),
			platformRole: z.enum(PLATFORM_ROLES).nullable(),
			via: z.enum(['session', 'key']),
			stepUpUntil: z.iso.datetime().nullable()
		})
	},
	async ({ principal }) => {
		if (principal === null) throw new ApiError('unauthenticated', 'Authentication is required');
		const userId = principal.kind === 'user' ? principal.userId : principal.issuerId;
		const user = await authServices().directory.findUserById(userId);
		if (!user) throw new ApiError('unauthenticated', 'Authentication is required');
		const stepUpAt = stepUpAtOf(principal);
		const until = stepUpAt === undefined ? null : stepUpUntil({ stepUpAt });
		return {
			id: user.id,
			email: user.email,
			displayName: user.displayName,
			platformRole: user.platformRole,
			via: principal.kind === 'user' ? ('session' as const) : ('key' as const),
			stepUpUntil: until === null ? null : new Date(until).toISOString()
		};
	}
);
