import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { planeConnectionViewSchema } from '../../../../../../../../shared/plane-connections';
import {
	planeConnectionDeps,
	validateConnection
} from '../../../../../../../services/plane-connections';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'plane.connect',
		rateClass: 'heavy',
		tags: ['planes'],
		summary: 'Check a Cloudflare connection again',
		description:
			'Checks the stored token against Cloudflare and records what it can do now. A token that expired or lost the permission to edit Workers scripts marks the connection invalid. A check that gets no answer from Cloudflare changes nothing. It needs a signed-in session, so an API key is refused.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		body: z.strictObject({}),
		response: planeConnectionViewSchema
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return validateConnection(planeConnectionDeps(), orgId, params.id);
	}
);
