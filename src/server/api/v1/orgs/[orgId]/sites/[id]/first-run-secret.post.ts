import { siteId } from '@contracts/common';
import { setResponseHeader } from 'h3';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { pendingSecretDeps, revealPendingSecret } from '../../../../../../services/owner-tokens';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'site.create',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Reveal the first admin password',
		description:
			'Returns the admin password the new site generated, once. It needs a signed-in session, so an API key is refused. A second call, an expired password and a site of another organisation are all not found. Do not send an Idempotency-Key header: a replayed answer would store the password.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: z.strictObject({ kind: z.literal('admin-password'), value: z.string() })
	},
	async ({ event, principal, resource, params, idempotencyKey }) => {
		if (principal === null || resource.orgId === undefined || resource.orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		if (idempotencyKey !== undefined) {
			throw new ApiError('validation', 'This route does not take an Idempotency-Key header');
		}
		setResponseHeader(event, 'Cache-Control', 'no-store');
		const value = await revealPendingSecret(await pendingSecretDeps(), {
			orgId: resource.orgId,
			siteId: params.id,
			kind: 'admin-password',
			principal
		});
		return { kind: 'admin-password' as const, value };
	}
);
