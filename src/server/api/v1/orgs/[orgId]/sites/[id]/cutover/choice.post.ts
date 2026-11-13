import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { cutoverViewSchema } from '../../../../../../../domain/cutover';
import {
	cutoverDecisionBody,
	cutoverServices,
	decideCutover
} from '../../../../../../../services/migration-cutover';
import { siteServices } from '../../../../../../../services/sites';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.cutover.decide',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Choose how a site move ends',
		description:
			'Sends a decision to the move that is observing the new site. rollback asks for a DNS reversal, which the move allows only while the new site has accepted no writes. keep-new, abandon-new-data and export-changes are the three choices once it has. The move reads the write count itself and records a refusal that the next read of the move shows. The body names one value; the request needs a signed-in session with a recent step-up. Answers 409 when the move is not observing the new site.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: cutoverDecisionBody,
		response: cutoverViewSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, body }) => {
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
		return decideCutover(siteServices(), cutoverServices(), {
			orgId,
			siteId: resolved,
			principal,
			value: body.value
		});
	}
);
