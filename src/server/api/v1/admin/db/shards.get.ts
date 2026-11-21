import { z } from 'zod';
import { consoleServicesOf, listShards } from '../../../../services/db-console';
import { organizationServices } from '../../../../services/organizations';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.db.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'List the database shards',
		description:
			'The shards the read-only console can query, with their size in bytes and, when a table is named, its row count on each shard. Needs step-up.',
		query: z.object({ table: z.string().max(64).optional() }),
		response: z.object({
			shards: z.array(
				z.object({
					shard: z.string(),
					sizeBytes: z.number().nullable(),
					rows: z.number().nullable().optional()
				})
			)
		})
	},
	async ({ query }) =>
		listShards(consoleServicesOf(await organizationServices().getDb()), query.table)
);
