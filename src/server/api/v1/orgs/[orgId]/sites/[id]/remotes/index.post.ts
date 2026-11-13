import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { remoteViewSchema } from '../../../../../../../../shared/repo-connections';
import { attachRemote, repoConnectionDeps } from '../../../../../../../services/repo-connections';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.remote.manage',
		rateClass: 'write',
		tags: ['repos'],
		summary: 'Attach a repository to a site',
		description:
			'Attaches one branch of a repository, through an active connection of the organisation, to the site in the path. The mount path must sit inside modules, themes or profiles. The interval is in minutes, from 5, and defaults to 60.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: z.strictObject({
			connectionId: z.string().min(1).max(64),
			repo: z.string().min(1).max(300),
			branch: z.string().min(1).max(200),
			mountPath: z.string().min(1).max(200),
			intervalMinutes: z.number().int().optional()
		}),
		response: remoteViewSchema,
		successStatus: 201
	},
	({ principal, resource, params, body }) => {
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
		return attachRemote(repoConnectionDeps(), { orgId, siteId: resolvedSite, ...body });
	}
);
