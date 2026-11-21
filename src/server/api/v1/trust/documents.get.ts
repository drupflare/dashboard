import { setResponseHeader } from 'h3';
import { z } from 'zod';
import { trustDocumentViewSchema } from '../../../../shared/trust';
import { listPublishedDocuments, trustServices } from '../../../services/trust';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'trust.documents.list',
		rateClass: 'read',
		tags: ['trust'],
		summary: 'List the published trust documents',
		description:
			'Lists the documents on the trust center that are published and not retired. Drafts and retired documents never appear here.',
		response: z.object({ items: z.array(trustDocumentViewSchema) })
	},
	async ({ event }) => {
		setResponseHeader(event, 'Cache-Control', 'public, max-age=300');
		return { items: await listPublishedDocuments(trustServices()) };
	}
);
