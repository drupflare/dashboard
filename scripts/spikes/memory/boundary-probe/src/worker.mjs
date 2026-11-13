import { DurableObject } from 'cloudflare:workers';
import { residency } from '../../residency.mjs';

const MiB = 1024 * 1024;
const PAGE = 65536;
const STRIDE = 4096;
const MAX_PAGES = 4096;

function touch(mem, fromByte, toByte) {
	const u8 = new Uint8Array(mem.buffer);
	for (let i = fromByte; i < toByte; i += STRIDE) u8[i] = 1;
}

export class SpikeMemoryBallast extends DurableObject {
	mem = null;
	chunks = [];

	linearMiB() {
		return this.mem ? this.mem.buffer.byteLength / MiB : 0;
	}

	ballastMiB() {
		let bytes = 0;
		for (const c of this.chunks) bytes += c.byteLength;
		return bytes / MiB;
	}

	async fetch(request) {
		const url = new URL(request.url);
		const p = url.searchParams;
		const op = url.pathname.slice(1);
		const t0 = performance.now();
		let extra = {};

		if (op === 'init') {
			const pages = Number(p.get('pages'));
			this.mem = new WebAssembly.Memory({ initial: pages, maximum: MAX_PAGES });
			touch(this.mem, 0, pages * PAGE);
		} else if (op === 'grow') {
			const pages = Number(p.get('pages'));
			const cur = this.mem.buffer.byteLength / PAGE;
			this.mem.grow(pages - cur);
			touch(this.mem, cur * PAGE, pages * PAGE);
		} else if (op === 'ballast') {
			const mb = Number(p.get('mb'));
			const chunk = new Uint8Array(mb * MiB);
			chunk.fill(1);
			this.chunks.push(chunk);
		} else if (op === 'burst') {
			const mb = Number(p.get('mb'));
			const tmp = [];
			for (let i = 0; i < mb / 8; i++) {
				const c = new Uint8Array(8 * MiB);
				c.fill(1);
				tmp.push(c);
			}
			extra = { burstMiB: mb };
			tmp.length = 0;
		} else if (op !== 'ping') {
			return Response.json({ ok: false, error: `unknown op ${op}` }, { status: 404 });
		}

		return Response.json({
			ok: true,
			op,
			linearMiB: this.linearMiB(),
			ballastMiB: this.ballastMiB(),
			wallMs: performance.now() - t0,
			residency: residency(this.ctx.id.toString(), Date.now()),
			...extra
		});
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname !== '/call') return new Response('not found', { status: 404 });
		const name = url.searchParams.get('name');
		const op = url.searchParams.get('op');
		const forward = new URL(`https://do/${op}`);
		for (const [k, v] of url.searchParams) {
			if (k !== 'name' && k !== 'op') forward.searchParams.set(k, v);
		}
		const stub = env.SPIKE_MEMORY_BALLAST.getByName(name);
		try {
			const res = await stub.fetch(forward);
			return new Response(await res.text(), {
				headers: { 'content-type': 'application/json' }
			});
		} catch (e) {
			return Response.json({
				ok: false,
				error: e.message,
				retryable: e.retryable ?? null,
				overloaded: e.overloaded ?? null,
				durableObjectReset: e.durableObjectReset ?? null
			});
		}
	}
};
