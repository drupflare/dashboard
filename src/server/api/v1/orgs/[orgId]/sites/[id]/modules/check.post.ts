import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { moduleCheckSchema } from '../../../../../../../../shared/modules';
import { checkSiteModule, moduleServices } from '../../../../../../../services/modules';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.module.read',
		rateClass: 'write',
		tags: ['sites'],
		summary: 'Check whether a module can be installed on a site',
		description:
			'Asks the site whether it can take a module from the list. Names any conflict with the code the site already has. Nothing is installed and nothing on the site changes. A site that cannot be asked gets a plain refusal, not an error. A site of another organisation is not found.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: z.strictObject({ name: z.string().min(1).max(200) }),
		response: moduleCheckSchema
	},
	async ({ principal, resource, params, body }) => {
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
		return checkSiteModule(moduleServices(), {
			orgId,
			siteId: resolvedSite,
			principal,
			name: body.name
		});
	}
);
