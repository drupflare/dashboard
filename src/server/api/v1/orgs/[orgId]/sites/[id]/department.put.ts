import { z } from 'zod';
import {
	siteDepartmentBodySchema,
	siteDepartmentViewSchema
} from '../../../../../../../shared/departments';
import { ApiError } from '../../../../../../../shared/errors';
import { actorOf, departmentServices, moveSite } from '../../../../../../services/departments';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.update',
		rateClass: 'write',
		tags: ['sites'],
		summary: 'Move a site to a department',
		description:
			'Places the site in a department, or back at the organization level with null. You need to be able to add sites to the department you move it into, and the Site Limits on the way up still apply. Only an organization owner or admin can take a site out of every department.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		body: siteDepartmentBodySchema,
		response: siteDepartmentViewSchema
	},
	({ principal, resource, params, body, facts }) => {
		const { orgId, siteId } = resource;
		if (orgId === undefined || orgId !== params.orgId || siteId === undefined) {
			throw new ApiError('not_found', 'Not found');
		}
		return moveSite(departmentServices(), orgId, actorOf(principal, facts), siteId, body);
	}
);
