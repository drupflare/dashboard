import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { IMPORT_CREDENTIAL_ID } from '../../../../../../shared/custody/import-credentials';
import { ApiError } from '../../../../../../shared/errors';
import { principalActor } from '../../../../../services/owner-tokens';
import {
	importRootSchema,
	importServices,
	startImportSurvey
} from '../../../../../services/site-import';
import { siteServices } from '../../../../../services/sites';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'site.import.survey',
		rateClass: 'heavy',
		tags: ['imports'],
		summary: 'Check a server before an import',
		description:
			'Starts a read-only check of the Drupal site at the path on the server of the key in the body and returns its operation. The host key must be confirmed first. Nothing on the server is changed. When the operation succeeds, its cursor is a JSON record whose dossier field holds the verdict, the refusals, the size estimate and the findings. Send an Idempotency-Key header; a repeat returns the same operation. It needs a signed-in session with a recent step-up.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.strictObject({
			credentialId: z.string().regex(IMPORT_CREDENTIAL_ID),
			root: importRootSchema
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
		const operation = await startImportSurvey(siteServices(), importServices(), {
			orgId,
			actor: principalActor(principal),
			credentialId: body.credentialId,
			root: body.root,
			idempotencyKey
		});
		return operation.operation;
	}
);
