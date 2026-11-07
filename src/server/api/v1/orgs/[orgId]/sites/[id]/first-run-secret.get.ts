import { siteId } from '@contracts/common';
import { adminPasswordState } from '@contracts/sites';
import { setResponseHeader } from 'h3';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { getReadySite } from '../../../../../../db/repos/sites';
import { adminPasswordStateOf, pendingSecretDeps } from '../../../../../../services/owner-tokens';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'site.create',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Read the state of the first admin password',
		description:
			'Says whether the first admin password can still be revealed, without revealing it. It needs a signed-in session, so an API key is refused, and the answer is never cached. A site of another organisation is not found.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: z.strictObject({ kind: z.literal('admin-password'), state: adminPasswordState })
	},
	async ({ event, principal, resource, params }) => {
		if (principal === null || resource.orgId === undefined || resource.orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		if (principal.kind !== 'user') {
			throw new ApiError('forbidden', 'This action needs a signed-in session', {
				reason: 'session_only'
			});
		}
		const site = await getReadySite(await siteServices().getDb(), resource.orgId, params.id);
		if (site === null) throw new ApiError('not_found', 'Not found');
		setResponseHeader(event, 'Cache-Control', 'no-store');
		const state = await adminPasswordStateOf(await pendingSecretDeps(), site);
		return { kind: 'admin-password' as const, state };
	}
);
