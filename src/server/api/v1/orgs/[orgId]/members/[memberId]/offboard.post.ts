import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { offboardBodySchema, offboardResultSchema } from '../../../../../../../shared/offboarding';
import { getMemberById } from '../../../../../../db/repos/organization';
import { stepUpFresh } from '../../../../../../domain/authorize';
import { governanceActor, governanceServices } from '../../../../../../services/governance';
import { offboardMember } from '../../../../../../services/offboarding';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'member.remove',
		rateClass: 'write',
		tags: ['members'],
		summary: 'Offboard a member',
		description:
			'Removes one person everywhere in the organization in one step: their membership and department roles, their site access, the agency access and invitations they created, their keys and their service accounts. With dryRun it lists what would happen and changes nothing. Running it for real needs a fresh sign-in. The last owner cannot be offboarded.',
		params: z.object({ orgId: z.string().min(1), memberId: z.string().min(1).max(64) }),
		body: offboardBodySchema,
		response: offboardResultSchema
	},
	async ({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const actor = governanceActor(principal, facts);
		if (body.dryRun !== true && !stepUpFresh(actor.principal, actor.facts)) {
			throw new ApiError('forbidden', 'Fresh authentication is required', {
				requires: 'step-up'
			});
		}
		const deps = governanceServices();
		const member = await getMemberById(await deps.getDb(), orgId, params.memberId);
		if (member === null) throw new ApiError('not_found', 'Not found');
		return offboardMember(deps, orgId, actor, member.userId, body);
	}
);
