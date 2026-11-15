import { digestSchema } from '@contracts/common';
import { RELEASE_KINDS } from '@contracts/releases';
import { z } from 'zod';
import { registerFromManifest, releaseServices } from '../../../../services/releases';
import { releaseView, releaseViewOf } from '../../../../services/rollout-view';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.releases.manage',
		rateClass: 'write',
		tags: ['admin'],
		summary: 'Register a release from its manifest',
		description:
			'Fetches the manifest at the address, checks it against the digest and stores the release. A repeat of the same release changes nothing. The signed release event uses the same check.',
		body: z.strictObject({
			kind: z.enum(RELEASE_KINDS),
			version: z.string().min(1).max(64),
			manifestUrl: z.url(),
			manifestDigest: digestSchema,
			releaseId: z.string().min(1).max(128).optional(),
			advisoryAt: z.number().int().nonnegative().nullable().default(null)
		}),
		response: z.object({ release: releaseView, created: z.boolean() }),
		successStatus: 201
	},
	async ({ body }) => {
		const services = releaseServices();
		const { release, created } = await registerFromManifest(services, {
			kind: body.kind,
			version: body.version,
			manifestUrl: body.manifestUrl,
			manifestDigest: body.manifestDigest,
			publishedAt: services.now(),
			advisoryAt: body.advisoryAt,
			...(body.releaseId === undefined ? {} : { releaseId: body.releaseId })
		});
		return { release: releaseViewOf(release, null), created };
	}
);
