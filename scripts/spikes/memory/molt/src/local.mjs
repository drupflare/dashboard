import worker from './worker.mjs';

export { MoltProbe } from './worker.mjs';

const MiB = 1024 * 1024;
const PAGE = 65536;
const STRIDE = 4096;
const MAX_PAGES = 4096;

let isolate = null;
let mem = null;
let memRef = null;
const kept = [];

function touch(m, from, to) {
	const u8 = new Uint8Array(m.buffer);
	for (let i = from; i < to; i += STRIDE) u8[i] = 1;
}

function fresh(mb) {
	const m = new WebAssembly.Memory({ initial: (mb * MiB) / PAGE, maximum: MAX_PAGES });
	touch(m, 0, mb * MiB);
	return m;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function plain(op, p) {
	isolate ??= crypto.randomUUID();
	const t0 = performance.now();
	const extra = {};

	if (op === 'setup') {
		const m = fresh(64);
		m.grow((170 * MiB - m.buffer.byteLength) / PAGE);
		touch(m, 64 * MiB, 170 * MiB);
		memRef = new WeakRef(m);
		mem = null;
	} else if (op === 'copy') {
		const image = new Uint8Array(50 * MiB);
		image.fill(1);
		const s = performance.now();
		const m = new WebAssembly.Memory({ initial: (64 * MiB) / PAGE, maximum: MAX_PAGES });
		new Uint8Array(m.buffer).set(image);
		extra.copyMs = performance.now() - s;
		mem = m;
	} else if (op === 'create') {
		mem = fresh(Number(p.get('mb')));
	} else if (op === 'churn') {
		const mb = Number(p.get('mb'));
		const n = Number(p.get('n'));
		const long = p.get('mode') === 'long';
		for (let i = 0; i < n; i++) {
			const c = new Uint8Array(mb * MiB);
			c.fill(1);
			if (long) kept.push(c);
			await sleep(Number(p.get('interval')));
		}
		extra.churnSteps = n;
	} else if (op !== 'ping') {
		return Response.json({ ok: false, error: `unknown op ${op}` }, { status: 404 });
	}

	const linear = mem ? mem.buffer.byteLength : 0;
	let keptBytes = 0;
	for (const c of kept) keptBytes += c.byteLength;
	return Response.json({
		ok: true,
		op,
		incarnation: isolate,
		linearMiB: linear / MiB,
		keptMiB: keptBytes / MiB,
		bytes: linear + keptBytes,
		droppedAlive: op === 'ping' && memRef ? memRef.deref() !== undefined : null,
		opMs: performance.now() - t0,
		...extra
	});
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === '/plain') return plain(url.searchParams.get('op'), url.searchParams);
		return worker.fetch(request, env, ctx);
	}
};
