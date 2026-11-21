import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { siteCreateBodySchema } from '../../../../../../../shared/site-create';
import {
	assertQuotaRoom,
	departmentServices,
	placeNewSite,
	targetOf
} from '../../../../../../services/departments';
import { createSite, siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'site.create',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Create a site in a department',
		description:
			'Starts a site create and places the new site in the department in the path. The Site Limit of the department and of each department above it counts every site below it, and a create over the limit is refused. Send an Idempotency-Key header; a repeat returns the same operation.',
		params: z.object({ orgId: z.string().min(1), deptId: z.string().min(1).max(64) }),
		body: siteCreateBodySchema,
		response: operationSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, body, idempotencyKey }) => {
		const { orgId, departmentId } = targetOf(resource, params);
		if (principal === null) throw new ApiError('not_found', 'Not found');
		if (idempotencyKey === undefined) {
			throw new ApiError('validation', 'The Idempotency-Key header is required');
		}
		const departments = departmentServices();
		await assertQuotaRoom(departments, orgId, departmentId);
		const { operation } = await createSite(siteServices(), {
			orgId,
			userId: principal.kind === 'user' ? principal.userId : principal.issuerId,
			kind: body.kind,
			name: body.name,
			hostnameLabel: body.hostnameLabel,
			templateEntryId: body.templateEntryId,
			bundleId: body.bundleId,
			plane: body.plane,
			connectionId: body.connectionId,
			customHost: body.customHost,
			idempotencyKey
		});
		const siteId = operation.targetIds[0];
		if (siteId) await placeNewSite(departments, orgId, siteId, departmentId);
		return operation;
	}
);
