import { mirrorById, parseMirrorSlug } from '../../../../shared/doc-mirrors';
import { mirrorDepsOf, readMirrorPage } from '../../../services/doc-mirror';

// the stored, already rendered page for one slug; the slug is looked up, never built into a URL
export default defineEventHandler(async (event) => {
	const mirror = mirrorById(getRouterParam(event, 'mirror'));
	const slug = getQuery(event).slug;
	const deps = mirrorDepsOf(event.context.cloudflare?.env);
	if (!mirror || !deps || (slug !== undefined && typeof slug !== 'string')) {
		throw createError({ statusCode: 404, statusMessage: 'Page Not Found' });
	}
	if (parseMirrorSlug(slug) === null) {
		throw createError({ statusCode: 404, statusMessage: 'Page Not Found' });
	}
	const view = await readMirrorPage(deps, mirror, slug);
	if (!view) throw createError({ statusCode: 404, statusMessage: 'Page Not Found' });
	setResponseHeader(event, 'cache-control', 'public, max-age=300');
	return view;
});
