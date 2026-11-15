import { z } from 'zod';
import { ladderServices, listLadderRows, listSwitches } from '../../../../services/ladder';
import { defineApi } from '../../../../utils/define-api';

const rowView = z.object({
	repairId: z.string(),
	source: z.string(),
	severity: z.string(),
	handle: z.string(),
	automation: z.string(),
	canRunToday: z.boolean(),
	reason: z.string().nullable()
});

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.ladder.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'Read the repair catalogue and the automatic repair switches',
		description:
			'The catalogue rows, with whether each can run today and why not, and the switches that turn automatic repair off or on for a site, an organisation or everything.',
		response: z.object({
			rows: z.array(rowView),
			switches: z.array(
				z.object({
					scope: z.enum(['global', 'organization', 'site']),
					scopeId: z.string(),
					auto: z.boolean(),
					updatedAt: z.number()
				})
			)
		})
	},
	async () => {
		const db = await ladderServices().getDb();
		return { rows: listLadderRows(), switches: await listSwitches(db) };
	}
);
