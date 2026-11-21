import { z } from 'zod';
import { rolloutView, viewOf } from '../../../../../../services/rollout-view';
import { stopReleaseRollout } from '../../../../../../services/rollouts';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.releases.manage',
		rateClass: 'write',
		tags: ['admin'],
		summary: 'Stop a rollout before its next ring',
		description:
			'Asks the rollout to stop. Rings that already received the release keep it; the next ring never starts. Answers 409 when the rollout has ended.',
		params: z.object({ releaseId: z.string().min(1) }),
		body: z.strictObject({ rolloutId: z.string().min(1) }),
		response: rolloutView
	},
	async ({ params, body }) =>
		viewOf(await stopReleaseRollout(siteServices(), params.releaseId, body.rolloutId), null)
);
