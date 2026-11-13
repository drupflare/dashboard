import { operationId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { IMPORT_CREDENTIAL_ID } from '../../../../../../shared/custody/import-credentials';
import { ApiError } from '../../../../../../shared/errors';
import { principalActor } from '../../../../../services/owner-tokens';
import { importServices, startSiteImport } from '../../../../../services/site-import';
import { siteServices } from '../../../../../services/sites';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'site.import',
		rateClass: 'heavy',
		tags: ['imports'],
		summary: 'Import a site from a server',
		description:
			'Starts the import of the server checked by the survey operation in the body into a new managed site and returns its operation. The engine copies the database over one read-only connection, converts it, creates the site on a Drupflare address, loads the copy, checks that the site answers, then deletes the key and the copies. The server is never changed. A database above the restore limit, or a survey that found a blocker, is refused with a plain reason before anything is created. Send an Idempotency-Key header; a repeat returns the same operation. It needs a signed-in session with a recent step-up.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.strictObject({
			credentialId: z.string().regex(IMPORT_CREDENTIAL_ID),
			surveyId: operationId,
			name: z.string().min(1).max(63),
			hostnameLabel: z.string().min(1).max(63).optional()
		}),
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, body, idempotencyKey }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		if (idempotencyKey === undefined) {
			throw new ApiError('validation', 'The Idempotency-Key header is required');
		}
		const operation = await startSiteImport(siteServices(), importServices(), {
			orgId,
			userId: principal.kind === 'user' ? principal.userId : principal.issuerId,
			actor: principalActor(principal),
			credentialId: body.credentialId,
			surveyId: body.surveyId,
			name: body.name,
			hostnameLabel: body.hostnameLabel,
			idempotencyKey
		});
		return operation.operation;
	}
);
