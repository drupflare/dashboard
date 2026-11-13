import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { checkBodySchema, checkViewSchema } from '../../../../../../shared/estate-view';
import { checkInventory } from '../../../../../services/estate';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'assessment.read',
		rateClass: 'write',
		tags: ['assessments'],
		summary: 'Check an inventory file',
		description:
			'Reads the inventory in the body the way an assessment would and returns how many rows and sites it holds, which rows were left out and why, and which columns were ignored. Nothing is stored and no site is contacted.',
		params: z.object({ orgId: z.string().min(1) }),
		body: checkBodySchema,
		response: checkViewSchema
	},
	({ resource, params, body }) => {
		if (resource.orgId === undefined || resource.orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return checkInventory(body.text);
	}
);
