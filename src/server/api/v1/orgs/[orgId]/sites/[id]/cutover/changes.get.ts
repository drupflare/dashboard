import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import {
	cutoverServices,
	exportCutoverChanges
} from '../../../../../../../services/migration-cutover';
import { siteServices } from '../../../../../../../services/sites';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.cutover.export',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Download the changes the new site took',
		description:
			'Streams the changes the new site accepted since the move as one SQL file, written for a MySQL or MariaDB database. It needs a signed-in session, so an API key is refused. Answers 404 until a move has saved its changes. An audit row is written before the download starts.',
		params: z.object({ orgId: z.string().min(1), id: siteId })
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
		return exportCutoverChanges(siteServices(), cutoverServices(), {
			orgId,
			siteId: resolved,
			principal
		});
	}
);
