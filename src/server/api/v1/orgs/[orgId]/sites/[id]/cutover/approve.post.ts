import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { cutoverViewSchema } from '../../../../../../../domain/cutover';
import { approveCutover, cutoverServices } from '../../../../../../../services/migration-cutover';
import { siteServices } from '../../../../../../../services/sites';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.cutover.decide',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Approve a site move',
		description:
			'Approves the move that is waiting for the owner. Approval lets the move apply the write policy to the source, copy the last changes, promote the new site and point the address at it. The request has no body and needs a signed-in session with a recent step-up. Answers 409 when the move is not waiting for approval or is no longer running.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: cutoverViewSchema,
		successStatus: 202
	},
	async ({ principal, resource, params }) => {
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
		return approveCutover(siteServices(), cutoverServices(), {
			orgId,
			siteId: resolved,
			principal
		});
	}
);
