import { getRequestWebStream } from 'h3';
import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import {
	bundleIntakeSchema,
	customBundleServices,
	intakeCustomBundle
} from '../../../../services/custom-bundles';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'site.create',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Upload a built Worker bundle',
		description:
			'Takes a built Worker as a .tar.gz request body (Content-Type application/gzip) and returns what the platform made of it. The archive holds a wrangler.jsonc at its top level, the built entry file that wrangler.jsonc names as main, any other built modules next to it and the assets directory it names. The archive is capped at 16 MiB and 40 MiB unpacked, with at most 20,000 entries, and it may hold no absolute path, no .. path and no link; each of those is refused with 422. The answer lists findings, each with a stable code and a severity, and whether the bundle is deployable. A deployable bundle is stored and gets a bundleId, which Create a site and Update a custom site accept. A bundle with a blocking finding is not stored and has a null bundleId. The same archive uploaded twice gives the same bundleId. The bundle is read, never run. Refused with 403 when the plan does not include custom code; the answer names the plan that does. Do not send an Idempotency-Key header; an upload is repeatable on its own.',
		params: z.object({ orgId: z.string().min(1) }),
		query: z.object({ fileName: z.string().max(200).optional() }),
		response: bundleIntakeSchema
	},
	async ({ event, principal, resource, params, query, idempotencyKey }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		if (idempotencyKey !== undefined) {
			throw new ApiError(
				'validation',
				'An upload is repeatable on its own; send it without an Idempotency-Key header'
			);
		}
		return intakeCustomBundle(customBundleServices(), {
			orgId,
			body: getRequestWebStream(event) ?? null,
			fileName: query.fileName
		});
	}
);
