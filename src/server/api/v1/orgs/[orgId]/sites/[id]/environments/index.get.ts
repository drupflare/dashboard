import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { listSiteEnvironments } from '../../../../../../../services/environments';
import { defineApi } from '../../../../../../../utils/define-api';

const environmentSchema = z.strictObject({
	id: z.string(),
	kind: z.enum(['staging', 'dev', 'preview']),
	name: z.string(),
	host: z.string(),
	status: z.string(),
	sourceBackupId: z.string().nullable(),
	ttlAt: z.number().int().nullable(),
	createdAt: z.number().int()
});

export default defineApi(
	{
		scope: 'site',
		action: 'site.environment.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'List the environments of a site',
		description:
			'Lists the staging, dev and preview environments of the site, newest first. Environments are not created yet, so the list is empty.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: z.object({ items: z.array(environmentSchema) })
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
		const rows = await listSiteEnvironments({ orgId, siteId: resolved });
		return {
			items: rows.map((row) => ({
				id: row.id,
				kind: row.kind,
				name: row.name,
				host: row.host,
				status: row.status,
				sourceBackupId: row.sourceBackupId,
				ttlAt: row.ttlAt,
				createdAt: row.createdAt
			}))
		};
	}
);
