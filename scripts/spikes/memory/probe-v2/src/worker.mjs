import { DurableObject } from 'cloudflare:workers';
import { residency } from '../residency.mjs';

const MiB = 1024 * 1024;
const PAGE = 65536;
const STRIDE = 4096;
const MAX_PAGES = 4096;

function touch(mem, fromByte, toByte) {
	const u8 = new Uint8Array(mem.buffer);
	for (let i = fromByte; i < toByte; i += STRIDE) u8[i] = 1;
}

export class SpikeMemoryV2 extends DurableObject {
	mem = null;
	chunks = [];
	incarnation = null;

	schema() {
		this.ctx.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL)'
		);
		this.ctx.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL)'
		);
	}

	counter() {
		const row = this.ctx.storage.sql.exec("SELECT v FROM kv WHERE k = 'n'").toArray()[0];
		return row ? row.v : 0;
	}

	tokenRows(token) {
		return this.ctx.storage.sql
			.exec('SELECT COUNT(*) AS n FROM log WHERE token = ?', token)
			.toArray()[0].n;
	}

	async fetch(request) {
		this.incarnation ??= crypto.randomUUID();
		const url = new URL(request.url);
		const p = url.searchParams;
		const op = url.pathname.slice(1);
		const tok = p.get('tok') ?? '';
		this.schema();

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
			this.ctx.storage.sql.exec(
				"INSERT INTO kv (k, v) VALUES ('n', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1"
			);
			this.ctx.storage.sql.exec('INSERT INTO log (token) VALUES (?)', tok);
			const chunk = new Uint8Array(Number(p.get('mb')) * MiB);
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
			tmp.length = 0;
		} else if (op === 'release') {
			this.chunks.length = 0;
		} else if (op !== 'ping' && op !== 'read') {
			return Response.json({ ok: false, error: `unknown op ${op}` }, { status: 404 });
		}

		const linearBytes = this.mem ? this.mem.buffer.byteLength : 0;
		let ballastBytes = 0;
		for (const c of this.chunks) ballastBytes += c.byteLength;
		const bytes = linearBytes + ballastBytes;

		return Response.json({
			ok: true,
			op,
			incarnation: this.incarnation,
			linearMiB: linearBytes / MiB,
			ballastMiB: ballastBytes / MiB,
			bytes,
			counter: this.counter(),
			tokenRows: tok ? this.tokenRows(tok) : null,
			residency: residency(this.ctx.id.toString(), bytes, Date.now())
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
		const stub = env.SPIKE_MEMORY_V2.getByName(name);
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
