import { z } from 'zod';
import {
	consoleServicesOf,
	queryBody,
	queryResultView,
	runQuery
} from '../../../../services/db-console';
import { organizationServices } from '../../../../services/organizations';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.db.read',
		rateClass: 'heavy',
		tags: ['admin'],
		summary: 'Run a read-only query',
		description:
			'Runs one SELECT on one shard or on all of them. Only a single SELECT passes: no comments, no second statement, no write, PRAGMA, ATTACH or WITH, and only a short list of functions. The result stops at 200 rows and 5 seconds. Secret columns are refused by name. Every statement is audited with its text and the admin. Needs step-up.',
		body: queryBody,
		response: z.object({ results: z.array(queryResultView) })
	},
	async ({ body, principal }) => {
		if (principal === null) throw new Error('an admin route always has a principal');
		const services = consoleServicesOf(await organizationServices().getDb());
		return { results: await runQuery(services, { ...body, principal }) };
	}
);
