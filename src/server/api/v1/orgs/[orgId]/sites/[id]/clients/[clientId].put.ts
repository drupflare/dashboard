import { siteId } from '@contracts/common';
import { z } from 'zod';
import { clientViewSchema } from '../../../../../../../../shared/agency';
import { ApiError } from '../../../../../../../../shared/errors';
import { addClientSite, clientServices } from '../../../../../../../services/client-workspaces';
import { actorOf } from '../../../../../../../services/delegations';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.client.manage',
		rateClass: 'write',
		tags: ['clients'],
		summary: 'Add a site to a client',
		description:
			'Groups a site of this organisation under a client. A site sits under one client at a time.',
		params: z.object({
			orgId: z.string().min(1),
			id: siteId,
			clientId: z.string().min(1).max(64)
		}),
		body: z.strictObject({}),
		response: clientViewSchema
	},
	({ principal, resource, params }) => {
		const { orgId, siteId: resolved } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolved === undefined ||
			orgId !== params.orgId ||
			resolved !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return addClientSite(
			clientServices(),
			orgId,
			actorOf(principal),
			params.clientId,
			resolved
		);
	}
);
