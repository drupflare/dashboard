import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { rolloutView, viewOf } from '../../../../../../services/rollout-view';
import { startReleaseRollout, startRolloutBody } from '../../../../../../services/rollouts';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.releases.manage',
		rateClass: 'heavy',
		tags: ['admin'],
		summary: 'Roll a release out across the fleet',
		description:
			'Sends the release to every live site, ring by ring. The next ring starts only when the one before it reads clean, and a bad reading stops the rollout. Needs a recent step-up. Send an Idempotency-Key header. Answers 409 while another rollout is running.',
		params: z.object({ releaseId: z.string().min(1) }),
		body: startRolloutBody,
		response: rolloutView,
		successStatus: 202
	},
	async ({ params, body, idempotencyKey }) => {
		if (idempotencyKey === undefined) {
			throw new ApiError('validation', 'The Idempotency-Key header is required');
		}
		const rollout = await startReleaseRollout(siteServices(), {
			releaseId: params.releaseId,
			body,
			idempotencyKey
		});
		return viewOf(rollout, null);
	}
);
