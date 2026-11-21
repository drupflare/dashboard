import { queryCollection, queryCollectionSearchSections } from '@nuxt/content/server';
import { dropDraftSections } from '../../../shared/docs';

// drafts stay out of the published index
export default defineEventHandler(async (event) => {
	const sections = await queryCollectionSearchSections(event, 'docs');
	if (import.meta.dev) return sections;
	const drafts = await queryCollection(event, 'docs')
		.where('draft', '=', true)
		.select('path')
		.all();
	return dropDraftSections(sections, new Set(drafts.map((row) => row.path)));
});
