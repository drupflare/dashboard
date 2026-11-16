const hits = new Map();
const mode = { kill: false, noclient: false, htmlStore: false, swAge: 86400 };
const stub = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.registration.unregister()));`;
const tag = /<script[^>]*data-spool-client[^>]*><\/script>/;

export default {
	async fetch(request, env) {
		const { pathname, searchParams } = new URL(request.url);
		if (pathname === '/__hits') return Response.json(Object.fromEntries(hits));
		if (pathname === '/__reset') {
			hits.clear();
			return Response.json({ ok: true });
		}
		if (pathname === '/__mode') {
			for (const [key, value] of searchParams)
				mode[key] = key === 'swAge' ? Number(value) : value === '1';
			return Response.json(mode);
		}
		hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
		const swHeaders = {
			'content-type': 'text/javascript',
			'cache-control': `max-age=${mode.swAge}`,
			'service-worker-allowed': '/'
		};
		if (pathname === '/spool-sw.js' && mode.kill)
			return new Response(stub, { headers: swHeaders });
		const response = await env.ASSETS.fetch(request);
		const headers = new Headers(response.headers);
		headers.set(
			'cache-control',
			pathname === '/spool-sw.js'
				? `max-age=${mode.swAge}`
				: 'public, max-age=31536000, immutable'
		);
		headers.set('service-worker-allowed', '/');
		const html = (headers.get('content-type') ?? '').startsWith('text/html');
		if (html && mode.htmlStore) headers.set('cache-control', 'no-store');
		if (html && (mode.kill || mode.noclient)) {
			return new Response((await response.text()).replace(tag, ''), {
				status: response.status,
				headers
			});
		}
		return new Response(response.body, { status: response.status, headers });
	}
};
