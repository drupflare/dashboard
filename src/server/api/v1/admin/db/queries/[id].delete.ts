import { z } from 'zod';
import { consoleServicesOf, deleteSavedQuery } from '../../../../../services/db-console';
import { organizationServices } from '../../../../../services/organizations';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.db.saved.manage',
		rateClass: 'write',
		tags: ['admin'],
		summary: 'Delete a saved query',
		description:
			'Removes a saved statement. The audit log keeps the record of who saved it. Needs step-up.',
		params: z.object({ id: z.string().min(1).max(128) }),
		successStatus: 204
	},
	async ({ params, principal }) => {
		if (principal === null) throw new Error('an admin route always has a principal');
		await deleteSavedQuery(consoleServicesOf(await organizationServices().getDb()), {
			id: params.id,
			principal
		});
	}
);
