import { z } from 'zod';
import { LADDER_SCOPES } from '../../../../../../engine/src/repair/rows';
import { ladderServices, setSwitch } from '../../../../services/ladder';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.ladder.manage',
		rateClass: 'write',
		tags: ['admin'],
		summary: 'Turn automatic repair on or off',
		description:
			'Sets the automatic repair switch for a site, an organisation or everything. The global switch needs the confirmation word. A scope id that matches nothing is refused.',
		body: z.strictObject({
			scope: z.enum(LADDER_SCOPES),
			scopeId: z.string().max(128).default(''),
			auto: z.boolean(),
			confirmation: z.string().optional()
		}),
		response: z.strictObject({
			scope: z.enum(LADDER_SCOPES),
			scopeId: z.string(),
			auto: z.boolean(),
			updatedAt: z.number()
		})
	},
	async ({ principal, body }) => {
		if (principal === null) throw new Error('an admin route always has a principal');
		return setSwitch(ladderServices(), { ...body, principal });
	}
);
