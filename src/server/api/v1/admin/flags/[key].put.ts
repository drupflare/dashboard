import { z } from 'zod';
import { nowUtc } from '../../../../../shared/utils/time';
import { FLAG_KEYS, setFlag } from '../../../../services/flags';
import { organizationServices } from '../../../../services/organizations';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.flags.manage',
		rateClass: 'write',
		tags: ['admin'],
		summary: 'Set a platform switch',
		description:
			'Turns one platform switch on or off. Needs step-up. The change is audited with the admin who made it. Turning ladder.auto on or off needs the confirmation word.',
		params: z.object({ key: z.enum(FLAG_KEYS) }),
		body: z.strictObject({
			value: z.boolean(),
			confirmation: z.string().max(64).optional()
		}),
		response: z.object({
			key: z.string(),
			value: z.boolean(),
			setBy: z.string().nullable(),
			setAt: z.number().nullable()
		})
	},
	async ({ params, body, principal }) => {
		if (principal === null) throw new Error('an admin route always has a principal');
		const db = await organizationServices().getDb();
		return setFlag(db, {
			key: params.key,
			value: body.value,
			...(body.confirmation === undefined ? {} : { confirmation: body.confirmation }),
			principal,
			now: nowUtc().toMillis()
		});
	}
);
