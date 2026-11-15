import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { permittedActions } from '../../../../../../domain/authorize';
import { siteSettingsServices } from '../../../../../../services/site-settings';
import { applySettings, settingChangeSchema } from '../../../../../../services/site-settings-write';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.config.runtime.write',
		rateClass: 'write',
		tags: ['sites'],
		summary: 'Change the settings of a site',
		description:
			'Starts a change of one or more settings of the site in the path and returns its operation. The caller needs the write permission of every group a setting belongs to. Each value is checked against what the site accepts, and the operation writes it, reads it back and records the change in the settings history. Send the etag from the settings read; a site that changed since answers 409 with the current values. A setting the platform sets, one set at deploy time, or one only an owner may change is refused with 422. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: z.strictObject({
			etag: z.string().min(1).max(200),
			changes: z.array(settingChangeSchema).min(1).max(32)
		}),
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, body, facts, idempotencyKey }) => {
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
		const { operation } = await applySettings(siteSettingsServices(), {
			orgId,
			siteId: resolved,
			actor: {
				principal,
				permitted: permittedActions({ principal, resource, facts }),
				owner: facts.membership?.role === 'owner'
			},
			changes: body.changes,
			etag: body.etag,
			idempotencyKey
		});
		return operation;
	}
);
