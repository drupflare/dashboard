import { appendFileSync } from 'node:fs';

const BASE = process.env.SPIKE_MEMORY_URL;
if (!BASE) throw new Error('SPIKE_MEMORY_URL is not set');

const OUT = new URL('./rows.jsonl', import.meta.url);
const RUN = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const STEP = 8;
const CAP = 224;
const OBJECTS = Number(process.env.SPIKE_MEMORY_OBJECTS ?? 5);
const SIBLING_MB = 48;

const cells = [
	{ arm: 'A1', id: 'A1-initial-64', init: 1024, mode: 'ladder' },
	{ arm: 'A1', id: 'A1-initial-80', init: 1280, mode: 'ladder' },
	{ arm: 'A1', id: 'A1-initial-96', init: 1536, mode: 'ladder' },
	{ arm: 'A1', id: 'A1-initial-112', init: 1792, mode: 'ladder' },
	{ arm: 'A2', id: 'A2-grow-80', init: 1024, grow: 1280, mode: 'ladder' },
	{ arm: 'A2', id: 'A2-grow-96', init: 1024, grow: 1536, mode: 'ladder' },
	{ arm: 'A2', id: 'A2-grow-112', init: 1024, grow: 1792, mode: 'ladder' },
	{ arm: 'A3', id: 'A3-hold-176', init: 1024, mode: 'hold', holdMb: 176 },
	{ arm: 'A3', id: 'A3-burst-176', init: 1024, mode: 'burst', holdMb: 176 },
	{ arm: 'A3', id: 'A3-hold-192', init: 1024, mode: 'hold', holdMb: 192 },
	{ arm: 'A3', id: 'A3-burst-192', init: 1024, mode: 'burst', holdMb: 192 },
	{ arm: 'A3', id: 'A3-hold-208', init: 1024, mode: 'hold', holdMb: 208 },
	{ arm: 'A3', id: 'A3-burst-208', init: 1024, mode: 'burst', holdMb: 208 },
	{ arm: 'A3', id: 'A3-hold-224', init: 1024, mode: 'hold', holdMb: 224 },
	{ arm: 'A3', id: 'A3-burst-224', init: 1024, mode: 'burst', holdMb: 224 },
	{ arm: 'A4', id: 'A4-solo', init: 1024, mode: 'ladder' },
	{ arm: 'A4', id: 'A4-sibling', init: 1024, mode: 'ladder', sibling: true }
];

function log(row) {
	appendFileSync(OUT, JSON.stringify({ run: RUN, ...row }) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(name, op, params = {}) {
	const qs = new URLSearchParams({ name, op, ...params });
	const t0 = performance.now();
	try {
		const res = await fetch(`${BASE}/call?${qs}`);
		const body = await res.json();
		return { httpStatus: res.status, ...body, driverMs: performance.now() - t0 };
	} catch (e) {
		return { ok: false, error: `driver: ${e.message}`, driverMs: performance.now() - t0 };
	}
}

function others(r) {
	const m = /others=(\d+)/.exec(r.residency ?? '');
	return m ? Number(m[1]) : null;
}

// the platform can re-run a request on a fresh object after a reset and report ok, so a reset
// shows as a break in the state the previous ok response reported, not as an error
function resetSeen(prev, r, expectedBallastMiB) {
	return !r.ok || r.linearMiB !== prev.linearMiB || r.ballastMiB !== expectedBallastMiB;
}

function record(cell, name, op, r, extra = {}) {
	log({
		arm: cell.arm,
		cell: cell.id,
		object: name,
		op,
		ok: r.ok === true,
		error: r.ok ? null : (r.error ?? null),
		retryable: r.retryable ?? null,
		overloaded: r.overloaded ?? null,
		durableObjectReset: r.durableObjectReset ?? null,
		linearMiB: r.linearMiB ?? null,
		ballastMiB: r.ballastMiB ?? null,
		others: r.ok ? others(r) : null,
		wallMs: r.wallMs ?? null,
		driverMs: r.driverMs,
		httpStatus: r.httpStatus ?? null,
		...extra
	});
}

// fills ballast in STEP chunks from the state the last ok response reported, stops at the first reset
async function fillBallast(cell, name, start, targetMb) {
	let steps = 0;
	let prev = start;
	for (let mb = STEP; mb <= targetMb; mb += STEP) {
		const r = await call(name, 'ballast', { mb: STEP });
		steps++;
		const reset = resetSeen(prev, r, prev.ballastMiB + STEP);
		record(cell, name, 'ballast', r, { targetMb: mb, step: steps, resetDetected: reset });
		if (reset) return { steps, state: prev, reset: true };
		prev = r;
	}
	return { steps, state: prev, reset: false };
}

async function siblingPinger(name, stop, start) {
	let prev = start;
	while (!stop.done) {
		const r = await call(name, 'ping');
		const reset = resetSeen(prev, r, prev.ballastMiB);
		record({ arm: 'A4', id: 'A4-sibling-B' }, name, 'ping', r, {
			role: 'sibling',
			resetDetected: reset
		});
		prev = r;
		await sleep(500);
	}
}

async function runObject(cell, index) {
	const name = `${RUN}-${cell.id}-${index}`;
	const init = await call(name, 'init', { pages: cell.init });
	record(cell, name, 'init', init);
	if (!init.ok || init.linearMiB !== cell.init / 16) return;
	let state = init;

	if (cell.grow) {
		const g = await call(name, 'grow', { pages: cell.grow });
		const reset = !g.ok || g.linearMiB !== cell.grow / 16;
		record(cell, name, 'grow', g, { resetDetected: reset });
		if (reset) return;
		state = g;
	}

	if (cell.mode === 'burst') {
		const b = await call(name, 'burst', { mb: cell.holdMb });
		const reset = !b.ok || b.linearMiB !== state.linearMiB;
		record(cell, name, 'burst', b, { burstMb: cell.holdMb, resetDetected: reset });
		return;
	}

	if (cell.mode === 'hold') {
		const fill = await fillBallast(cell, name, state, cell.holdMb);
		if (fill.reset) return;
		let prev = fill.state;
		for (let k = 1; k <= 5; k++) {
			await sleep(1000);
			const p = await call(name, 'ping');
			const reset = resetSeen(prev, p, prev.ballastMiB);
			record(cell, name, 'ping', p, { holdInvocation: k, resetDetected: reset });
			if (reset) return;
			prev = p;
		}
		return;
	}

	let stop = null;
	let pinger = null;
	if (cell.sibling) {
		const sib = `${RUN}-${cell.id}-B-${index}`;
		const sibCell = { ...cell, id: `${cell.id}-B` };
		const sInit = await call(sib, 'init', { pages: 1024 });
		record(sibCell, sib, 'init', sInit, { role: 'sibling' });
		if (!sInit.ok) return;
		const sFill = await fillBallast(sibCell, sib, sInit, SIBLING_MB);
		if (sFill.reset) return;
		stop = { done: false };
		pinger = siblingPinger(sib, stop, sFill.state);
	}

	const ladder = await fillBallast(cell, name, state, CAP);
	if (stop) {
		stop.done = true;
		await pinger;
	}
	log({
		arm: cell.arm,
		cell: cell.id,
		object: name,
		op: 'summary',
		linearMiB: ladder.state.linearMiB,
		lastOkMb: ladder.state.ballastMiB,
		resetDetected: ladder.reset,
		steps: ladder.steps
	});
}

for (const cell of cells) {
	for (let i = 1; i <= OBJECTS; i++) {
		await runObject(cell, i);
	}
	console.log(`done ${cell.id}`);
}
