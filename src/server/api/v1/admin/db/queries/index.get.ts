import { z } from 'zod';
import {
	consoleServicesOf,
	listSavedQueries,
	savedQueryView
} from '../../../../../services/db-console';
import { organizationServices } from '../../../../../services/organizations';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.db.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'List saved queries',
		description: 'The saved read-only statements, newest first. Needs step-up.',
		response: z.object({ items: z.array(savedQueryView) })
	},
	async () => ({
		items: await listSavedQueries(consoleServicesOf(await organizationServices().getDb()))
	})
);
