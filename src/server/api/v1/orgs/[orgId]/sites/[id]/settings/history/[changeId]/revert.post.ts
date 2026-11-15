import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../../../shared/errors';
import { permittedActions } from '../../../../../../../../../domain/authorize';
import { siteSettingsServices } from '../../../../../../../../../services/site-settings';
import { revertSettings } from '../../../../../../../../../services/site-settings-write';
import { defineApi } from '../../../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.config.runtime.write',
		rateClass: 'write',
		tags: ['sites'],
		summary: 'Revert a settings change',
		description:
			'Starts a change that puts every setting of the named change back to what it held before, and returns its operation. The caller needs the write permission of every group the settings belong to, and the same checks as a new change apply. A change that was already reverted answers 409. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({
			orgId: z.string().min(1),
			id: siteId,
			changeId: z.string().min(1).max(200)
		}),
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, facts, idempotencyKey }) => {
		const { orgId, siteId: resolved } = resource;
		if (
			principal === null ||
			facts === null ||
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
		const { operation } = await revertSettings(siteSettingsServices(), {
			orgId,
			siteId: resolved,
			changeId: params.changeId,
			actor: {
				principal,
				permitted: permittedActions({ principal, resource, facts }),
				owner: facts.membership?.role === 'owner'
			},
			idempotencyKey
		});
		return operation;
	}
);
