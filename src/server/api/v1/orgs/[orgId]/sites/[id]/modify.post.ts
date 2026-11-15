import { newId, siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { modifyBodySchema } from '../../../../../../../shared/modify';
import { modifyServices, modifySiteFiles } from '../../../../../../services/modify';
import { principalActor } from '../../../../../../services/owner-tokens';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.modify',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Deliver an edit to a Drupal site',
		description:
			'Sends the files of one custom module, theme or profile to the site and returns the operation. The files are the whole set: any file of that module the request leaves out is removed from the site. Paths must sit in modules/custom/<name>/, themes/custom/<name>/ or profiles/custom/<name>/, and each file is text, given as plain text or base64. A restore point is taken first, the site boots the new files and puts the old ones back if they fail, and a passing edit is added to the code history with its files so it can be rolled back to. Refused with 422 when the site is not an active Drupal site, when Drupflare holds no access to it, when the plan does not include custom code, or when a path or file is not allowed. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: modifyBodySchema,
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
		const { operation } = await modifySiteFiles(modifyServices(), {
			orgId,
			siteId: resolvedSite,
			files: body.files,
			note: body.note,
			actor: principalActor(principal),
			idempotencyKey,
			operationId: newId('op')
		});
		return operation;
	}
);
