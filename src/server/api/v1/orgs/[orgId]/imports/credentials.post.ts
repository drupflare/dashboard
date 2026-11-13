import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { principalActor } from '../../../../../services/owner-tokens';
import {
	createImportCredential,
	importHostSchema,
	importServices
} from '../../../../../services/site-import';
import { siteServices } from '../../../../../services/sites';
import { defineApi } from '../../../../../utils/define-api';

const credentialViewSchema = z.strictObject({
	id: z.string(),
	publicKey: z.string(),
	host: z.string(),
	port: z.int(),
	username: z.string(),
	expiresAt: z.string()
});

export default defineApi(
	{
		scope: 'organization',
		action: 'site.import.credential',
		rateClass: 'heavy',
		tags: ['imports'],
		summary: 'Make a key for an import',
		description:
			'Makes a one-time key for the server in the body and returns the public line to add to its authorized keys. The key lasts 24 hours and is deleted when the import ends. The private half is stored sealed and is never returned. It needs a signed-in session with a recent step-up.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.strictObject({
			host: importHostSchema,
			port: z.int().min(1).max(65535).default(22),
			username: z
				.string()
				.min(1)
				.max(32)
				.regex(/^[a-z_][a-z0-9_-]*$/i)
		}),
		response: credentialViewSchema,
		successStatus: 201
	},
	({ principal, resource, params, body }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return createImportCredential(siteServices(), importServices(), {
			orgId,
			userId: principal.kind === 'user' ? principal.userId : principal.issuerId,
			actor: principalActor(principal),
			host: body.host,
			port: body.port,
			username: body.username
		});
	}
);
