import { DurableObject } from 'cloudflare:workers';
import { residency } from '../residency.mjs';

const MiB = 1024 * 1024;
const PAGE = 65536;
const STRIDE = 4096;
const MAX_PAGES = 4096;

let isolate = null;

function isolateId() {
	isolate ??= crypto.randomUUID();
	return isolate;
}

function touch(mem, from, to) {
	const u8 = new Uint8Array(mem.buffer);
	for (let i = from; i < to; i += STRIDE) u8[i] = 1;
}

function fresh(mb) {
	const mem = new WebAssembly.Memory({ initial: (mb * MiB) / PAGE, maximum: MAX_PAGES });
	touch(mem, 0, mb * MiB);
	return mem;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class MoltProbe extends DurableObject {
	mem = null;
	memRef = null;
	chunks = [];
	kept = [];
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

	pending() {
		const row = this.ctx.storage.sql
			.exec("SELECT v FROM kv WHERE k = 'molt_pending'")
			.toArray()[0];
		return row ? row.v : 0;
	}

	async fetch(request) {
		this.incarnation ??= crypto.randomUUID();
		this.schema();
		const url = new URL(request.url);
		const p = url.searchParams;
		const op = url.pathname.slice(1);
		const tok = p.get('tok') ?? '';
		const t0 = performance.now();
		const extra = {};

		if (op === 'init') {
			this.mem = fresh(Number(p.get('mb')));
		} else if (op === 'grow') {
			const cur = this.mem.buffer.byteLength;
			const to = Number(p.get('mb')) * MiB;
			this.mem.grow((to - cur) / PAGE);
			touch(this.mem, cur, to);
		} else if (op === 'drop') {
			this.memRef = this.mem ? new WeakRef(this.mem) : null;
			this.mem = null;
		} else if (op === 'create') {
			this.mem = fresh(Number(p.get('mb')));
		} else if (op === 'molt') {
			this.memRef = this.mem ? new WeakRef(this.mem) : null;
			this.mem = fresh(Number(p.get('mb')));
		} else if (op === 'copy') {
			const image = new Uint8Array(50 * MiB);
			image.fill(1);
			const s = performance.now();
			const mem = new WebAssembly.Memory({ initial: (64 * MiB) / PAGE, maximum: MAX_PAGES });
			new Uint8Array(mem.buffer).set(image);
			extra.copyMs = performance.now() - s;
			this.mem = mem;
		} else if (op === 'ballast') {
			this.ctx.storage.sql.exec(
				"INSERT INTO kv (k, v) VALUES ('n', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1"
			);
			this.ctx.storage.sql.exec('INSERT INTO log (token) VALUES (?)', tok);
			const c = new Uint8Array(Number(p.get('mb')) * MiB);
			c.fill(1);
			this.chunks.push(c);
		} else if (op === 'churn') {
			const mb = Number(p.get('mb'));
			const n = Number(p.get('n'));
			const long = p.get('mode') === 'long';
			for (let i = 0; i < n; i++) {
				const c = new Uint8Array(mb * MiB);
				c.fill(1);
				if (long) this.kept.push(c);
				await sleep(Number(p.get('interval')));
			}
			extra.churnSteps = n;
		} else if (op === 'alarm-arm') {
			this.ctx.storage.sql.exec(
				"INSERT INTO kv (k, v) VALUES ('molt_pending', 1) ON CONFLICT(k) DO UPDATE SET v = 1"
			);
			await this.ctx.storage.setAlarm(Date.now() + Number(p.get('delay')));
		} else if (op === 'abort') {
			this.ctx.abort('molt probe abort', { retryAlarm: false });
		} else if (op !== 'ping' && op !== 'read') {
			return Response.json({ ok: false, error: `unknown op ${op}` }, { status: 404 });
		}

		const linear = this.mem ? this.mem.buffer.byteLength : 0;
		let ballast = 0;
		for (const c of this.chunks) ballast += c.byteLength;
		let kept = 0;
		for (const c of this.kept) kept += c.byteLength;
		const bytes = linear + ballast + kept;

		return Response.json({
			ok: true,
			op,
			incarnation: this.incarnation,
			isolate: isolateId(),
			linearMiB: linear / MiB,
			ballastMiB: ballast / MiB,
			keptMiB: kept / MiB,
			bytes,
			counter: this.counter(),
			tokenRows: tok ? this.tokenRows(tok) : null,
			alarmPending: this.pending(),
			droppedAlive: op === 'ping' && this.memRef ? this.memRef.deref() !== undefined : null,
			opMs: performance.now() - t0,
			residency: residency(this.ctx.id.toString(), bytes, Date.now()),
			...extra
		});
	}

	async alarm(alarmInfo) {
		this.schema();
		if (!this.pending() || (alarmInfo?.retryCount ?? 0) > 0) return;
		this.ctx.storage.sql.exec("DELETE FROM kv WHERE k = 'molt_pending'");
		this.ctx.abort('molt alarm', { retryAlarm: false });
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
		const stub = env.MOLT_PROBE.getByName(name);
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
