import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import {
	cutoverPolicyBody,
	cutoverServices,
	startCutover
} from '../../../../../../../services/migration-cutover';
import { siteServices } from '../../../../../../../services/sites';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.cutover',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Start moving a site by cutover',
		description:
			"Starts the move of the address in the body from the source server to the managed site in the path, and returns its operation. The body names the source, the address that moves and how the source treats writes while the move runs: freeze (maintenance page), read-only (the site serves and refuses writes) or delta (a short freeze for the last copy). The move waits for the owner's approval before it touches the source's writes, and it never deletes the source. Send an Idempotency-Key header; a repeat returns the same operation. Needs a signed-in session with a recent step-up. Answers 409 when another change to the site is running, 422 when the site is not a live managed site, and 501 until moves are available.",
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: cutoverPolicyBody,
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, body, idempotencyKey }) => {
		const { orgId, siteId: resolved } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolved === undefined ||
			orgId !== params.orgId ||
			resolved !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		if (idempotencyKey === undefined) {
			throw new ApiError('validation', 'The Idempotency-Key header is required');
		}
		const { operation } = await startCutover(siteServices(), cutoverServices(), {
			orgId,
			siteId: resolved,
			policy: body.policy,
			source: body.source,
			hostname: body.hostname,
			idempotencyKey
		});
		return operation;
	}
);
