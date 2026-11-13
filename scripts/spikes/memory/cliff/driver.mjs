import { appendFileSync } from 'node:fs';

const BASE = process.env.SPIKE_MEMORY_V4_URL;
if (!BASE) throw new Error('SPIKE_MEMORY_V4_URL is not set');

const OUT = new URL('./rows.jsonl', import.meta.url);
const RUN = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const SEED = Number(process.env.SPIKE_MEMORY_V4_SEED ?? 20261113);
const PASS = process.env.SPIKE_MEMORY_V4_PASS ?? '1';
const STEP = 8;
const CAP = 288;
const PAGES_PER_MIB = 16;

const passes = {
	1: [108, 109, 110, 111, 112].map((g) => ({
		id: `G-64to${g}`,
		family: 'grown',
		init: 64,
		grow: g,
		n: 10
	})),
	2: [
		{ id: 'GR-48to110', family: 'grown48', init: 48, grow: 110, n: 5 },
		{ id: 'I-110', family: 'initial', init: 110, grow: null, n: 5 }
	]
};
const cells = passes[PASS];
if (!cells) throw new Error(`unknown pass ${PASS}`);

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
		const text = await res.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			return {
				t,
				httpStatus: res.status,
				ok: false,
				error: 'non-json',
				bodyHead: text.slice(0, 160),
				driverMs: performance.now() - t0
			};
		}
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
		bodyHead: r.bodyHead ?? null,
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
		await runLadder(unit, ctx);
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
	pass: PASS,
	seed: SEED,
	mainObjects: mainOrder.length,
	mainOrder: mainOrder.map((u) => u.cell.id),
	step: STEP,
	capMiB: CAP
});

let runIndex = 0;
for (const unit of mainOrder) {
	await runUnit(unit, runIndex++);
	if (runIndex % 10 === 0) console.log(`main ${runIndex}/${mainOrder.length}`);
}
console.log('all done');
