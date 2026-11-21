import { trustDocumentViewSchema, trustUploadSchema } from '../../../../../../shared/trust';
import { principalActor } from '../../../../../services/owner-tokens';
import { trustServices, uploadDocument } from '../../../../../services/trust';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.trust.manage',
		rateClass: 'write',
		tags: ['admin'],
		summary: 'Upload a trust document as a draft',
		description:
			'Stores one file as a draft. The file is PDF, DOCX, Markdown or plain text, up to 10 MB. Publish it to show it on the trust center.',
		body: trustUploadSchema,
		response: trustDocumentViewSchema,
		successStatus: 201
	},
	async ({ body, principal }) => {
		if (principal === null) throw new Error('an admin route always has a principal');
		return uploadDocument(trustServices(), principalActor(principal), body);
	}
);
