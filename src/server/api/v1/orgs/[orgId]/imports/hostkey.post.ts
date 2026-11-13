import { z } from 'zod';
import { IMPORT_CREDENTIAL_ID } from '../../../../../../shared/custody/import-credentials';
import { ApiError } from '../../../../../../shared/errors';
import { principalActor } from '../../../../../services/owner-tokens';
import { checkHostKey, importServices } from '../../../../../services/site-import';
import { siteServices } from '../../../../../services/sites';
import { defineApi } from '../../../../../utils/define-api';

const hostKeyViewSchema = z.strictObject({
	credentialId: z.string(),
	hostKeyType: z.string(),
	fingerprint: z.string(),
	confirmed: z.boolean()
});

export default defineApi(
	{
		scope: 'organization',
		action: 'site.import.credential',
		rateClass: 'heavy',
		tags: ['imports'],
		summary: 'Read or confirm the host key of a server',
		description:
			'Connects to the server of the key in the body, reads the host key it presents and stops before any login, so no command runs. Without confirm it returns the key type and fingerprint to show the owner. With confirm.fingerprint it reads the key again and stores it only when it matches, then every later connection must present that key. It needs a signed-in session with a recent step-up.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.strictObject({
			credentialId: z.string().regex(IMPORT_CREDENTIAL_ID),
			confirm: z.strictObject({ fingerprint: z.string().min(1).max(200) }).optional()
		}),
		response: hostKeyViewSchema,
		successStatus: 200
	},
	({ principal, resource, params, body }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return checkHostKey(siteServices(), importServices(), {
			orgId,
			actor: principalActor(principal),
			credentialId: body.credentialId,
			...(body.confirm === undefined ? {} : { confirm: body.confirm })
		});
	}
);
