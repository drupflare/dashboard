import { appendFileSync } from 'node:fs';

const BASE = process.env.SPIKE_MEMORY_V3_URL;
if (!BASE) throw new Error('SPIKE_MEMORY_V3_URL is not set');
const OUT = new URL('./rows-v3.jsonl', import.meta.url);
const RUN = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const SEED = 20261112;
const N = 5;
const STEP = 8;
const CAP = 320;
const LINEAR0 = 96;
const HOLD0 = 40;
const IDLE_MS = 30000;
const ARMS = ['control', 'A', 'B', 'C', 'D', 'idle'];

function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffle(xs, rand) {
	const out = [...xs];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function emit(obj) {
	appendFileSync(OUT, JSON.stringify({ run: RUN, seed: SEED, ...obj }) + '\n');
}

async function call(object, op, params = {}) {
	const u = new URL(`${BASE}/call`);
	u.searchParams.set('name', object);
	u.searchParams.set('op', op);
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
	const t = Date.now();
	try {
		const res = await fetch(u);
		const body = await res.json();
		return { t, ms: Date.now() - t, httpStatus: res.status, ...body };
	} catch (e) {
		return { t, ms: Date.now() - t, ok: false, error: `driver: ${e.message}` };
	}
}

function unitState(arm, index, pilot) {
	return { arm, index, pilot, object: `${RUN}-${arm}-${index}`, last: null, step: 0, k: 0 };
}

async function track(u, op, params, label, { expectReset = false } = {}) {
	const r = await call(u.object, op, params);
	const reset = r.ok === true && u.last !== null && r.incarnation !== u.last.incarnation;
	u.step++;
	emit({
		type: 'call',
		arm: u.arm,
		index: u.index,
		pilot: u.pilot,
		object: u.object,
		step: u.step,
		label,
		op,
		t: r.t,
		ms: r.ms,
		httpStatus: r.httpStatus ?? null,
		ok: r.ok === true,
		error: r.ok ? null : (r.error ?? null),
		incarnation: r.incarnation ?? null,
		isolate: r.isolate ?? null,
		linearMiB: r.linearMiB ?? null,
		ballastMiB: r.ballastMiB ?? null,
		counter: r.counter ?? null,
		tokenRows: r.tokenRows ?? null,
		alarmPending: r.alarmPending ?? null,
		others: r.residency?.others ?? null,
		otherBytes: r.residency?.otherBytes ?? null,
		resetDetected: reset,
		expectedReset: expectReset
	});
	if (r.ok) u.last = r;
	return { r, reset };
}

async function ballast(u, mb, label) {
	const tok = `${u.object}-b${++u.k}`;
	const b = await track(u, 'ballast', { mb, tok }, label);
	if (!b.r.ok || b.reset) return { ok: false, reset: b.reset };
	const rd = await track(u, 'read', { tok }, `${label}-read`);
	if (!rd.r.ok || rd.reset) return { ok: false, reset: rd.reset };
	return { ok: true };
}

async function hold(u, label) {
	for (let k = 0; k < HOLD0 / STEP; k++) {
		const s = await ballast(u, STEP, label);
		if (!s.ok) return `${label}-${s.reset ? 'reset' : 'error'}`;
	}
	return null;
}

async function setup(u) {
	const i = await track(u, 'init', { mb: 64 }, 'init');
	if (!i.r.ok || i.reset) return 'init';
	const g = await track(u, 'grow', { mb: LINEAR0 }, 'grow');
	if (!g.r.ok || g.reset) return `grow-${g.reset ? 'reset' : 'error'}`;
	return hold(u, 'hold');
}

async function climb(u) {
	let good = u.last.linearMiB + u.last.ballastMiB;
	while (good + STEP <= CAP) {
		const s = await ballast(u, STEP, 'climb');
		if (!s.ok) {
			return s.reset
				? {
						lastGoodMiB: good,
						interval: [good, good + STEP],
						resetDetected: true,
						capReached: false
					}
				: { lastGoodMiB: good, error: true, resetDetected: false, capReached: false };
		}
		good = u.last.linearMiB + u.last.ballastMiB;
	}
	return { lastGoodMiB: good, resetDetected: false, capReached: true };
}

async function runArm(u) {
	const out = { failure: null, moltResetAt: null, idleEvicted: null, alarmObserved: null };
	const fail = await setup(u);
	if (fail) return { ...out, failure: fail };

	const molt = async (label, op, params) => {
		const m = await track(u, op, params, label);
		if (m.reset) out.moltResetAt = label;
		if (!m.r.ok) out.failure = `${label}-error`;
		return !m.r.ok || m.reset;
	};

	if (u.arm === 'A') {
		if (await molt('molt-same-call', 'molt', { mb: 64 })) return out;
	} else if (u.arm === 'B') {
		if (await molt('drop', 'drop', {})) return out;
		if (await molt('create', 'create', { mb: 64 })) return out;
	} else if (u.arm === 'C') {
		const a = await track(u, 'alarm-arm', { delay: 500 }, 'alarm-arm');
		if (!a.r.ok) return { ...out, failure: 'alarm-arm-error' };
		let fired = false;
		for (let p = 0; p < 40 && !fired; p++) {
			await sleep(500);
			const pg = await track(u, 'ping', {}, 'poll-for-abort', { expectReset: true });
			if (!pg.r.ok) return { ...out, failure: 'poll-error' };
			fired = pg.reset;
		}
		out.alarmObserved = fired;
		if (!fired) return { ...out, failure: 'alarm-not-observed' };
		if (await molt('create-after-abort', 'create', { mb: 64 })) return out;
		const re = await hold(u, 'rehold');
		if (re) return { ...out, failure: re };
	} else if (u.arm === 'D') {
		if (await molt('drop', 'drop', {})) return out;
		await sleep(IDLE_MS);
		const p = await track(u, 'ping', {}, 'ping-after-idle', { expectReset: true });
		if (!p.r.ok) return { ...out, failure: 'idle-ping-error' };
		out.idleEvicted = p.reset;
		if (await molt('create', 'create', { mb: 64 })) return out;
	} else if (u.arm === 'idle') {
		await sleep(IDLE_MS);
		const p = await track(u, 'ping', {}, 'ping-after-idle', { expectReset: true });
		if (!p.r.ok) return { ...out, failure: 'idle-ping-error' };
		out.idleEvicted = p.reset;
		return out;
	}

	const cl = await climb(u);
	return { ...out, ...cl };
}

const units = [];
for (const arm of ARMS) {
	for (let i = 1; i <= N; i++) units.push(unitState(arm, i, false));
}
const order = shuffle(units, rng(SEED));
const pilot = unitState('control', 0, true);
emit({
	type: 'manifest',
	arms: ARMS,
	n: N,
	step: STEP,
	cap: CAP,
	linear0: LINEAR0,
	hold0: HOLD0,
	idleMs: IDLE_MS,
	order: order.map((u) => `${u.arm}-${u.index}`)
});
emit({ type: 'run-start', at: new Date().toISOString() });

const pilotOut = await runArm(pilot);
emit({ type: 'summary', arm: 'control', index: 0, pilot: true, object: pilot.object, ...pilotOut });
if (pilotOut.failure) {
	emit({
		type: 'run-stop',
		reason: `pilot failed: ${pilotOut.failure}`,
		at: new Date().toISOString()
	});
	console.log(`pilot failed: ${pilotOut.failure}`);
} else {
	for (const u of order) {
		const out = await runArm(u);
		emit({
			type: 'summary',
			arm: u.arm,
			index: u.index,
			pilot: false,
			object: u.object,
			...out
		});
		console.log(
			`${u.arm} ${u.index} done: ${out.failure ?? (out.capReached ? 'cap' : out.lastGoodMiB)}`
		);
	}
	emit({ type: 'run-end', at: new Date().toISOString() });
	console.log('all done');
}
