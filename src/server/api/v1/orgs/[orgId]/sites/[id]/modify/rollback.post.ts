import { newId, siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { modifyRollbackBodySchema } from '../../../../../../../../shared/modify';
import { modifyServices, rollbackSiteEdit } from '../../../../../../../services/modify';
import { principalActor } from '../../../../../../../services/owner-tokens';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.modify',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Roll a site back to an earlier edit',
		description:
			'Sends the stored files of an earlier edit to the site again and returns the operation. Only the module, theme or profile that edit delivered goes back; the data and the other code stay as they are. The entry is named by its id from the code history, and it must be an edit that kept its files. The data version guard that applies to a release rollback applies here too. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: modifyRollbackBodySchema,
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, body, idempotencyKey }) => {
		const { orgId, siteId: resolvedSite } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolvedSite === undefined ||
			orgId !== params.orgId ||
			resolvedSite !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		if (idempotencyKey === undefined) {
			throw new ApiError('validation', 'The Idempotency-Key header is required');
		}
		const { operation } = await rollbackSiteEdit(modifyServices(), {
			orgId,
			siteId: resolvedSite,
			revisionId: body.revision,
			actor: principalActor(principal),
			idempotencyKey,
			operationId: newId('op')
		});
		return operation;
	}
);
