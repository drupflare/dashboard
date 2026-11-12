import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { adoptSite } from '../../../../../../services/site-adopt';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.adopt',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Adopt a self-managed site',
		description:
			"Starts the move of the self-managed site in the path to a new managed site and returns its operation. The engine copies the site's database, creates the managed site on a Drupflare address, restores the copy into it and checks that it answers. The source site is never changed or deleted, and the managed copy is one-way. A database above the restore limit stops the operation with a plain reason before anything is created. The request has no body and needs a signed-in session with a recent step-up. Send an Idempotency-Key header; a repeat returns the same operation. Answers 409 when the site was already adopted or another change to it is running, 422 when the site is not self-managed or not live, and 403 when the plan has no room for another site.",
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, idempotencyKey }) => {
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
		const operation = await adoptSite(siteServices(), {
			orgId,
			siteId: resolved,
			// a session is the only principal that gets here, so this is the signed-in person
			userId: principal.kind === 'user' ? principal.userId : principal.issuerId,
			idempotencyKey
		});
		return operation.operation;
	}
);
