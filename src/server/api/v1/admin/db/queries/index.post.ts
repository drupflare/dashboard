import {
	consoleServicesOf,
	saveQuery,
	savedQueryBody,
	savedQueryView
} from '../../../../../services/db-console';
import { organizationServices } from '../../../../../services/organizations';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.db.saved.manage',
		rateClass: 'write',
		tags: ['admin'],
		summary: 'Save a query',
		description:
			'Saves a statement under a name. The statement has to pass the same check as a typed one. Needs step-up.',
		body: savedQueryBody,
		response: savedQueryView,
		successStatus: 201
	},
	async ({ body, principal }) => {
		if (principal === null) throw new Error('an admin route always has a principal');
		return saveQuery(consoleServicesOf(await organizationServices().getDb()), {
			...body,
			principal
		});
	}
);
