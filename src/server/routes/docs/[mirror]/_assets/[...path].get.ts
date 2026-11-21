import { mirrorById } from '../../../../../shared/doc-mirrors';
import { mirrorDepsOf, readMirrorAsset } from '../../../../services/doc-mirror';

// cached image bytes only; the type comes from a fixed table, so SVG and unknown types are refused
export default defineEventHandler(async (event) => {
	const mirror = mirrorById(getRouterParam(event, 'mirror'));
	const deps = mirrorDepsOf(event.context.cloudflare?.env);
	const path = getRouterParam(event, 'path') ?? '';
	if (!mirror || !deps) throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	const asset = await readMirrorAsset(deps, mirror, path);
	if (!asset) throw createError({ statusCode: 404, statusMessage: 'Not Found' });
	const etag = `"${asset.sha}"`;
	setResponseHeaders(event, {
		'content-type': asset.type,
		'x-content-type-options': 'nosniff',
		'content-security-policy': "default-src 'none'; sandbox",
		'cache-control': 'public, max-age=86400',
		etag
	});
	if (getRequestHeader(event, 'if-none-match') === etag) {
		setResponseStatus(event, 304);
		return null;
	}
	return new Uint8Array(asset.bytes);
});
