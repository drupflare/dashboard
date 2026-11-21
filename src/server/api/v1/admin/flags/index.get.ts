import { z } from 'zod';
import { listFlags } from '../../../../services/flags';
import { organizationServices } from '../../../../services/organizations';
import { defineApi } from '../../../../utils/define-api';

const flagView = z.object({
	key: z.string(),
	value: z.boolean(),
	setBy: z.string().nullable(),
	setAt: z.number().nullable()
});

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.flags.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'Read the platform switches',
		description:
			'Every platform switch with its value and who set it last. A switch nobody has set reads as off.',
		response: z.object({ flags: z.array(flagView) })
	},
	async () => ({ flags: await listFlags(await organizationServices().getDb()) })
);
