import { z } from 'zod';
import { nowUtc } from '../../../../shared/utils/time';
import { countOpenAbuse } from '../../../db/repos/abuse';
import { adminOverview, adminWork } from '../../../db/repos/admin';
import { findRollingRollout } from '../../../db/repos/rollouts';
import { listFlags } from '../../../services/flags';
import { organizationServices } from '../../../services/organizations';
import { defineApi } from '../../../utils/define-api';

const counts = z.record(z.string(), z.number());

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.aggregates.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'Read the platform totals',
		description:
			'Counts of users, organisations, sites by state and operations by status, plus the cards on the admin front page: operations in flight and failed, open abuse reports, the switches that are on, and the release rollout running now. Needs the admin role and a Cloudflare Access login.',
		response: z.object({
			users: z.number(),
			organizations: z.number(),
			sites: counts,
			operations: counts,
			work: z.object({ running: z.number(), failedLastDay: z.number() }),
			abuseOpen: z.number(),
			switchesOn: z.array(z.string()),
			// the rollout with a ring still moving, summed across rings; null when none runs
			rollout: z
				.object({
					releaseId: z.string(),
					upgraded: z.number(),
					failed: z.number(),
					reverted: z.number(),
					stuck: z.number()
				})
				.nullable()
		})
	},
	async () => {
		const db = await organizationServices().getDb();
		const totals = await adminOverview(db);
		const work = await adminWork(db, nowUtc().toMillis());
		const rolling = await findRollingRollout(db);
		const rings = rolling ? Object.values(rolling.progress) : [];
		const sum = (key: 'upgraded' | 'failed' | 'reverted' | 'stuck') =>
			rings.reduce((total, ring) => total + (ring?.[key].length ?? 0), 0);
		return {
			...totals,
			work: { running: work.running, failedLastDay: work.failedLastDay },
			abuseOpen: await countOpenAbuse(db),
			switchesOn: (await listFlags(db)).filter((flag) => flag.value).map((flag) => flag.key),
			rollout: rolling
				? {
						releaseId: rolling.releaseId,
						upgraded: sum('upgraded'),
						failed: sum('failed'),
						reverted: sum('reverted'),
						stuck: sum('stuck')
					}
				: null
		};
	}
);
