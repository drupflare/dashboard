import { z } from 'zod';
import { trustDocumentViewSchema } from '../../../../../../shared/trust';
import { listAllDocuments, trustServices } from '../../../../../services/trust';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.trust.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'List every trust document',
		description: 'Lists drafts, published and retired trust documents with their hashes.',
		response: z.object({ items: z.array(trustDocumentViewSchema) })
	},
	async () => ({ items: await listAllDocuments(trustServices()) })
);
