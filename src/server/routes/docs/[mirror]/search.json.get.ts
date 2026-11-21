import { mirrorById } from '../../../../shared/doc-mirrors';
import { mirrorDepsOf, readMirrorSearch } from '../../../services/doc-mirror';

export default defineEventHandler(async (event) => {
	const mirror = mirrorById(getRouterParam(event, 'mirror'));
	const deps = mirrorDepsOf(event.context.cloudflare?.env);
	if (!mirror || !deps) throw createError({ statusCode: 404, statusMessage: 'Page Not Found' });
	setResponseHeader(event, 'cache-control', 'public, max-age=300');
	return readMirrorSearch(deps, mirror);
});
