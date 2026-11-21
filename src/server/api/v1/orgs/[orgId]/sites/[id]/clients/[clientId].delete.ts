import { siteId } from '@contracts/common';
import { z } from 'zod';
import { deletedSchema } from '../../../../../../../../shared/agency';
import { ApiError } from '../../../../../../../../shared/errors';
import { clientServices, removeClientSite } from '../../../../../../../services/client-workspaces';
import { actorOf } from '../../../../../../../services/delegations';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.client.manage',
		rateClass: 'write',
		tags: ['clients'],
		summary: 'Remove a site from a client',
		description: 'Takes a site out of a client grouping. The site stays in the organisation.',
		params: z.object({
			orgId: z.string().min(1),
			id: siteId,
			clientId: z.string().min(1).max(64)
		}),
		response: deletedSchema
	},
	async ({ principal, resource, params }) => {
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
		await removeClientSite(
			clientServices(),
			orgId,
			actorOf(principal),
			params.clientId,
			resolved
		);
		return { deleted: true as const };
	}
);
