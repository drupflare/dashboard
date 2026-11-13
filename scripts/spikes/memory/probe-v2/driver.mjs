import { appendFileSync } from 'node:fs';

const BASE = process.env.SPIKE_MEMORY_V2_URL;
if (!BASE) throw new Error('SPIKE_MEMORY_V2_URL is not set');

const OUT = new URL('./rows.jsonl', import.meta.url);
const RUN = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const SEED = Number(process.env.SPIKE_MEMORY_V2_SEED ?? 20261112);
const STEP = 8;
const CAP = 288;
const PAGES_PER_MIB = 16;
const BURST_LINEAR = 64;
const CALIBRATION_OBJECTS = 10;
const REPLAY_CELLS = ['I-64', 'G-64to96', 'B-total240'];
const REPLAY_N = 5;

const cells = [
	...[80, 96, 100, 104, 108, 112].map((g) => ({
		id: `G-64to${g}`,
		family: 'grown',
		init: 64,
		grow: g,
		n: 5
	})),
	...[48, 56, 64, 80, 96, 112].map((i) => ({
		id: `I-${i}`,
		family: 'initial',
		init: i,
		grow: null,
		n: i === 64 || i === 112 ? 10 : 5
	})),
	...[96, 112].map((g) => ({ id: `GR-48to${g}`, family: 'grown48', init: 48, grow: g, n: 5 })),
	...[176, 192, 208, 224, 240, 256, 272, 288].map((t) => ({
		id: `B-total${t}`,
		family: 'burst',
		init: BURST_LINEAR,
		burstTotal: t,
		n: 5
	}))
];
const byId = new Map(cells.map((c) => [c.id, c]));

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

async function call(name, op, params = {}) {
	const qs = new URLSearchParams({ name, op, ...params });
	const t = Date.now();
	const t0 = performance.now();
	try {
		const res = await fetch(`${BASE}/call?${qs}`);
		const body = await res.json();
		return { t, httpStatus: res.status, ...body, driverMs: performance.now() - t0 };
	} catch (e) {
		return { t, ok: false, error: `driver: ${e.message}`, driverMs: performance.now() - t0 };
	}
}

// a reset shows as a new incarnation on a reply that still says ok; the platform re-runs the call
function resetOf(prev, r) {
	return prev !== null && r.ok === true && r.incarnation !== prev.incarnation;
}

function emit(obj) {
	appendFileSync(OUT, JSON.stringify(obj) + '\n');
}

function log(ctx, step, op, r, extra = {}) {
	emit({
		run: RUN,
		seed: SEED,
		...ctx,
		step,
		op,
		t: r.t,
		httpStatus: r.httpStatus ?? null,
		ok: r.ok === true,
		error: r.ok ? null : (r.error ?? null),
		durableObjectReset: r.durableObjectReset ?? null,
		incarnation: r.incarnation ?? null,
		linearMiB: r.linearMiB ?? null,
		ballastMiB: r.ballastMiB ?? null,
		bytes: r.bytes ?? null,
		counter: r.counter ?? null,
		tokenRows: r.tokenRows ?? null,
		others: r.residency?.others ?? null,
		otherBytes: r.residency?.otherBytes ?? null,
		isolate: r.residency?.instance ?? null,
		driverMs: r.driverMs,
		...extra
	});
}

async function runLadder(unit, ctx) {
	const { cell } = unit;
	const name = ctx.object;
	let step = 0;

	const init = await call(name, 'init', { pages: cell.init * PAGES_PER_MIB });
	log(ctx, ++step, 'init', init, { expectedLinearMiB: cell.init });
	if (!init.ok || init.linearMiB !== cell.init) {
		return emit({
			...ctx,
			op: 'summary',
			error: 'init',
			resetDetected: false,
			ackedBallast: 0
		});
	}

	let good = init;
	let acked = 0;
	let lastRead = null;
	let crossing = null;
	let error = null;

	if (cell.grow) {
		const g = await call(name, 'grow', { pages: cell.grow * PAGES_PER_MIB });
		const reset = resetOf(good, g);
		log(ctx, ++step, 'grow', g, { expectedLinearMiB: cell.grow, resetDetected: reset });
		if (!g.ok || g.linearMiB !== cell.grow) error = 'grow';
		else if (reset) crossing = { step, op: 'grow', read: g };
		else good = g;
	}

	if (!error && !crossing) {
		for (let k = 1; ; k++) {
			const next = good.ballastMiB + STEP;
			if (good.linearMiB + next > CAP) break;
			const tok = `${name}-b${k}`;
			const r = await call(name, 'ballast', { mb: STEP, tok });
			const reset = resetOf(good, r);
			step++;
			log(ctx, step, 'ballast', r, {
				tok,
				ballastTargetMiB: next,
				ackedBefore: acked,
				incarnationBefore: good.incarnation,
				resetDetected: reset
			});
			if (!r.ok) {
				error = 'ballast';
				break;
			}
			acked++;

			const rd = await call(name, 'read', { tok });
			step++;
			log(ctx, step, 'read', rd, { tok, ackedBallast: acked, resetDetected: resetOf(r, rd) });
			if (!rd.ok) {
				error = 'read';
				break;
			}
			lastRead = rd;

			if (reset) {
				crossing = { step, op: 'ballast', tok, read: rd };
				break;
			}
			if (r.ballastMiB !== next || r.linearMiB !== good.linearMiB) {
				error = 'inconsistent';
				break;
			}
			good = r;
		}
	}

	const lastGoodTotalMiB = good.linearMiB + good.ballastMiB;
	emit({
		run: RUN,
		seed: SEED,
		...ctx,
		op: 'summary',
		linearMiB: good.linearMiB,
		lastGoodBallastMiB: good.ballastMiB,
		lastGoodTotalMiB,
		resetDetected: crossing !== null,
		crossingStep: crossing?.step ?? null,
		crossingOp: crossing?.op ?? null,
		trueLimitMiB: crossing ? [lastGoodTotalMiB, lastGoodTotalMiB + STEP] : null,
		ackedBallast: acked,
		counterAfter: lastRead?.counter ?? null,
		crossingTokenRows: crossing?.read?.tokenRows ?? null,
		incarnationBefore: good.incarnation,
		incarnationAfter: crossing ? crossing.read.incarnation : good.incarnation,
		capReached: !crossing && !error,
		error
	});
}

async function runBurst(unit, ctx) {
	const { cell } = unit;
	const name = ctx.object;
	const init = await call(name, 'init', { pages: BURST_LINEAR * PAGES_PER_MIB });
	log(ctx, 1, 'init', init, { expectedLinearMiB: BURST_LINEAR });
	if (!init.ok || init.linearMiB !== BURST_LINEAR) {
		return emit({
			...ctx,
			op: 'summary',
			error: 'init',
			resetDetected: false,
			survived: false
		});
	}

	const mb = cell.burstTotal - BURST_LINEAR;
	const b = await call(name, 'burst', { mb });
	const reset = resetOf(init, b);
	const survived = b.ok === true && !reset;
	log(ctx, 2, 'burst', b, {
		burstTotalMiB: cell.burstTotal,
		burstBallastMiB: mb,
		resetDetected: reset,
		survived
	});

	let releasedBallastMiB = null;
	if (survived) {
		const rel = await call(name, 'release');
		log(ctx, 3, 'release', rel, { resetDetected: resetOf(b, rel) });
		releasedBallastMiB = rel.ballastMiB ?? null;
	}

	emit({
		run: RUN,
		seed: SEED,
		...ctx,
		op: 'summary',
		burstTotalMiB: cell.burstTotal,
		survived,
		resetDetected: reset,
		incarnationBefore: init.incarnation,
		incarnationAfter: b.incarnation ?? null,
		ballastAfterReleaseMiB: releasedBallastMiB,
		error: b.ok ? null : (b.error ?? null)
	});
}

async function runUnit(unit, runIndex) {
	const { cell, phase, index } = unit;
	const ctx = {
		phase,
		cell: cell.id,
		family: cell.family,
		object: `${RUN}-${cell.id}-${phase}-${index}`,
		runIndex
	};
	try {
		if (cell.family === 'burst') await runBurst(unit, ctx);
		else await runLadder(unit, ctx);
	} catch (e) {
		emit({ ...ctx, op: 'summary', error: `driver: ${e.message}`, resetDetected: null });
	}
}

const mainUnits = [];
for (const cell of cells) {
	for (let i = 1; i <= cell.n; i++) mainUnits.push({ cell, phase: 'main', index: i });
}
const mainOrder = shuffle(mainUnits, rng(SEED));

emit({
	op: 'manifest',
	run: RUN,
	seed: SEED,
	mainObjects: mainOrder.length,
	mainOrder: mainOrder.map((u) => u.cell.id),
	replayCells: REPLAY_CELLS,
	replayN: REPLAY_N,
	calibrationObjects: CALIBRATION_OBJECTS,
	step: STEP,
	capMiB: CAP
});

for (let i = 1; i <= CALIBRATION_OBJECTS; i++) {
	const object = `${RUN}-calibration-${i}`;
	const ctx = {
		phase: 'calibration',
		cell: 'calibration',
		family: 'calibration',
		object,
		runIndex: i - 1
	};
	log(ctx, 1, 'ping', await call(object, 'ping'));
}
console.log('calibration done');

let runIndex = 0;
for (const unit of mainOrder) {
	await runUnit(unit, runIndex++);
	if (runIndex % 20 === 0) console.log(`main ${runIndex}/${mainOrder.length}`);
}
console.log('main done');

for (const id of REPLAY_CELLS) {
	const cell = byId.get(id);
	for (let i = 1; i <= REPLAY_N; i++) {
		await runUnit({ cell, phase: 'replay', index: i }, runIndex++);
	}
	console.log(`replay ${id} done`);
}
console.log('all done');
