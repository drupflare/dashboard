import { z } from 'zod';
import { openPublishedDocument, trustServices } from '../../../../../services/trust';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'trust.documents.download',
		rateClass: 'read',
		tags: ['trust'],
		summary: 'Download a published trust document',
		description:
			'Streams one published trust document as an attachment. The stored file is looked up by the document id, never by a path from the request.',
		params: z.object({ id: z.string().min(1).max(80) })
	},
	async ({ params }) => {
		const { stream, filename, contentType } = await openPublishedDocument(
			trustServices(),
			params.id
		);
		return new Response(stream, {
			status: 200,
			headers: {
				'Content-Type': contentType,
				'Content-Disposition': `attachment; filename="${filename}"`,
				'X-Content-Type-Options': 'nosniff',
				'Cache-Control': 'public, max-age=300'
			}
		});
	}
);
