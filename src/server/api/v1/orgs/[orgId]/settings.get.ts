import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import { orgSettingsSchema } from '../../../../../shared/org-settings';
import { governanceServices } from '../../../../services/governance';
import { getOrgSettings } from '../../../../services/org-settings';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'org.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'Read the organization settings',
		description:
			'Returns the organization settings. Today that is whether department admins can decide access review items.',
		params: z.object({ orgId: z.string().min(1) }),
		response: orgSettingsSchema
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return getOrgSettings(governanceServices(), orgId);
	}
);
