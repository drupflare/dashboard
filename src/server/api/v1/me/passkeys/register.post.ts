import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { setResponseHeader } from 'h3';
import { z } from 'zod';
import {
	PASSKEY_NAME_MAX,
	creationOptionsSchema,
	registrationResponseSchema
} from '../../../../integrations/webauthn';
import {
	finishPasskeyRegistration,
	identityDeps,
	startPasskeyRegistration
} from '../../../../services/identities';
import { stepUpAtOf, type UserPrincipal } from '../../../../utils/auth';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'write',
		tags: ['me'],
		summary: 'Register a passkey',
		description:
			'Two calls, both needing a fresh authentication. Phase options returns the creation options. Phase verify checks the new credential against that challenge and stores it.',
		body: z.discriminatedUnion('phase', [
			z.object({ phase: z.literal('options') }),
			z.object({
				phase: z.literal('verify'),
				response: registrationResponseSchema,
				name: z.string().max(PASSKEY_NAME_MAX).optional()
			})
		]),
		response: z.union([
			z.object({ options: creationOptionsSchema }),
			z.object({
				passkey: z.object({
					id: z.string(),
					name: z.string(),
					deviceType: z.enum(['singleDevice', 'multiDevice']),
					backedUp: z.boolean(),
					createdAt: z.iso.datetime()
				})
			})
		])
	},
	async ({ event, principal, body }) => {
		const user = principal as UserPrincipal;
		const deps = identityDeps();
		setResponseHeader(event, 'cache-control', 'no-store');
		if (body.phase === 'options') {
			const options = await startPasskeyRegistration(deps, {
				userId: user.userId,
				stepUpAt: stepUpAtOf(user)
			});
			return { options };
		}
		const passkey = await finishPasskeyRegistration(deps, {
			userId: user.userId,
			stepUpAt: stepUpAtOf(user),
			response: body.response as RegistrationResponseJSON,
			name: body.name
		});
		return {
			passkey: {
				id: passkey.id,
				name: passkey.name,
				deviceType: passkey.deviceType,
				backedUp: passkey.backedUp,
				createdAt: new Date(passkey.createdAt).toISOString()
			}
		};
	}
);
