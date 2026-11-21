import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import { orgSettingsSchema } from '../../../../../shared/org-settings';
import { governanceActor, governanceServices } from '../../../../services/governance';
import { setOrgSettings } from '../../../../services/org-settings';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'org.update',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Change the organization settings',
		description:
			'Sets whether department admins can decide access review items. Owners and admins change it. Turning it off keeps every decision already made and stops department admins from making new ones. The change is audited with the old and new value.',
		params: z.object({ orgId: z.string().min(1) }),
		body: orgSettingsSchema,
		response: orgSettingsSchema
	},
	({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return setOrgSettings(governanceServices(), orgId, governanceActor(principal, facts), body);
	}
);
