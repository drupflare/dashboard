import { DurableObject } from 'cloudflare:workers';

export class TenantCounter extends DurableObject {
	hit() {
		const count = (this.ctx.storage.kv.get('count') ?? 0) + 1;
		this.ctx.storage.kv.put('count', count);
		return count;
	}

	read() {
		return this.ctx.storage.kv.get('count') ?? 0;
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const stub = env.COUNTER.get(env.COUNTER.idFromName(url.hostname));
		if (url.pathname === '/__count') return Response.json({ count: await stub.read() });
		await stub.hit();
		return new Response('<!doctype html><title>tenant</title><p>ok</p>', {
			status: 200,
			headers: { 'content-type': 'text/html; charset=utf-8' }
		});
	}
};
