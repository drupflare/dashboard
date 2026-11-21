import { z } from 'zod';
import { breakGlassView, supportGrantView } from '../../../../../shared/support';
import { listAdminGrants, supportServices } from '../../../../services/support';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.support-grants.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'List live support grants and break-glass starts',
		description:
			'Support grants that are live now, soonest to end first, and the recent break-glass starts with their reasons. Metadata only.',
		response: z.object({
			grants: z.array(supportGrantView),
			breakGlass: z.array(breakGlassView)
		})
	},
	() => listAdminGrants(supportServices())
);
