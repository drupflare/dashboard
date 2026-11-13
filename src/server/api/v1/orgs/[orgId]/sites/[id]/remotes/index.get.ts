import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { remoteListSchema } from '../../../../../../../../shared/repo-connections';
import { listRemotes, repoConnectionDeps } from '../../../../../../../services/repo-connections';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.read',
		rateClass: 'read',
		tags: ['repos'],
		summary: 'List the repositories attached to a site',
		description:
			'Lists the remotes of the site in the path with the result of the last pull on each. A site of another organisation is not found.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: remoteListSchema
	},
	async ({ principal, resource, params }) => {
		const { orgId, siteId: resolvedSite } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolvedSite === undefined ||
			orgId !== params.orgId ||
			resolvedSite !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return { items: await listRemotes(repoConnectionDeps(), orgId, resolvedSite) };
	}
);
