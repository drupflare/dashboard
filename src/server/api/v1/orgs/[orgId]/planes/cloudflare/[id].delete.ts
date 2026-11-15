import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { revokeResultSchema } from '../../../../../../../shared/plane-connections';
import {
	planeConnectionDeps,
	revokeConnection
} from '../../../../../../services/plane-connections';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'plane.revoke',
		rateClass: 'write',
		tags: ['planes'],
		summary: 'Revoke a Cloudflare connection',
		description:
			'Wipes the stored token. When Drupflare made the token, it also asks Cloudflare to delete it; the narrower token has no permission to manage tokens, so Cloudflare may refuse, and the answer says whether you must delete it yourself. Sites that run on the account refuse the revoke unless force lists each site ID. A second revoke changes nothing. It needs a signed-in session with a fresh sign-in, so an API key is refused.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		query: z.object({ force: z.string().max(2048).optional() }),
		response: revokeResultSchema
	},
	({ resource, params, query }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const force = (query.force ?? '').split(',').filter((item) => item !== '');
		return revokeConnection(planeConnectionDeps(), orgId, params.id, force);
	}
);
