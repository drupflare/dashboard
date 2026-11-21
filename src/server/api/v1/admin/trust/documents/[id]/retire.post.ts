import { z } from 'zod';
import { trustDocumentViewSchema } from '../../../../../../../shared/trust';
import { principalActor } from '../../../../../../services/owner-tokens';
import { retireDocument, trustServices } from '../../../../../../services/trust';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.trust.manage',
		rateClass: 'write',
		tags: ['admin'],
		summary: 'Retire a trust document',
		description:
			'Removes a published document from the trust center. The file stays in storage. The change is written to the platform audit log.',
		params: z.object({ id: z.string().min(1).max(80) }),
		response: trustDocumentViewSchema
	},
	async ({ params, principal }) => {
		if (principal === null) throw new Error('an admin route always has a principal');
		return retireDocument(trustServices(), principalActor(principal), params.id);
	}
);
