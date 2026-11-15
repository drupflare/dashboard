import { RELEASE_KINDS } from '@contracts/releases';
import { z } from 'zod';
import { latestRolloutsOf } from '../../../../db/repos/rollouts';
import { listRegistered, releaseServices } from '../../../../services/releases';
import { releaseView, releaseViewOf } from '../../../../services/rollout-view';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.aggregates.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'List registered releases',
		description:
			'The releases of one kind, newest first, each with its latest rollout when it has one.',
		query: z.object({ kind: z.enum(RELEASE_KINDS).default('worker') }),
		response: z.object({ releases: z.array(releaseView) })
	},
	async ({ query }) => {
		const services = releaseServices();
		const releases = await listRegistered(services, query.kind);
		const rollouts = await latestRolloutsOf(
			await services.getDb(),
			releases.map((release) => release.id)
		);
		return {
			releases: releases.map((release) =>
				releaseViewOf(release, rollouts.get(release.id) ?? null)
			)
		};
	}
);
