import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { getRelease } from '../../../../../../db/repos/releases';
import { latestRolloutsOf } from '../../../../../../db/repos/rollouts';
import { rolloutView, viewOf } from '../../../../../../services/rollout-view';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.aggregates.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'Read the latest rollout of a release',
		description:
			'The ring the rollout is in, how many sites each ring holds, what stopped it and why, and the time from the advisory to the last ring reached.',
		params: z.object({ releaseId: z.string().min(1) }),
		response: z.object({ rollout: rolloutView.nullable() })
	},
	async ({ params }) => {
		const db = await siteServices().getDb();
		const release = await getRelease(db, params.releaseId);
		if (release === null) throw new ApiError('not_found', 'Not found');
		const latest = (await latestRolloutsOf(db, [release.id])).get(release.id);
		return { rollout: latest === undefined ? null : viewOf(latest, release.advisoryAt) };
	}
);
