import { readFileSync } from 'node:fs';

const rows = readFileSync(new URL('./rows.jsonl', import.meta.url), 'utf8')
	.trim()
	.split('\n')
	.filter(Boolean)
	.map((line) => JSON.parse(line));
const manifest = rows.find((r) => r.op === 'manifest');
const summaries = rows.filter((r) => r.op === 'summary');
const byObject = new Map(summaries.map((s) => [s.object, s]));

function stats(xs) {
	const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
	if (!s.length) return 'n=0';
	const n = s.length;
	const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
	return `n=${n} median ${median} range ${s[0]} to ${s[n - 1]}`;
}

function pearson(xs, ys) {
	const n = xs.length;
	if (n < 3) return null;
	const mx = xs.reduce((a, b) => a + b, 0) / n;
	const my = ys.reduce((a, b) => a + b, 0) / n;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < n; i++) {
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
		syy += (ys[i] - my) ** 2;
	}
	return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

console.log(`run ${manifest.run} seed ${manifest.seed} main objects ${manifest.mainObjects}`);

const cellIds = [...new Set(summaries.map((s) => s.cell))].filter((c) => c !== 'calibration');
for (const id of cellIds) {
	const main = summaries.filter((s) => s.cell === id && s.phase === 'main');
	const replay = summaries.filter((s) => s.cell === id && s.phase === 'replay');
	if (!main.length) continue;
	console.log(`cell ${id} (${main[0].family})`);
	if (main[0].family === 'burst') {
		const survived = main.filter((s) => s.survived).length;
		console.log(`  total ${main[0].burstTotalMiB} MiB: survived ${survived}/${main.length}`);
		if (replay.length)
			console.log(
				`  replay survived ${replay.filter((s) => s.survived).length}/${replay.length}`
			);
		continue;
	}
	const resets = main.filter((s) => s.resetDetected).length;
	console.log(
		`  main objects ${main.length}, resets ${resets}, errors ${main.filter((s) => s.error).length}`
	);
	console.log(`  linear MiB ${[...new Set(main.map((s) => s.linearMiB))].join(', ')}`);
	console.log(`  last good ballast MiB ${stats(main.map((s) => s.lastGoodBallastMiB))}`);
	console.log(`  last good total MiB ${stats(main.map((s) => s.lastGoodTotalMiB))}`);
	const intervals = main
		.filter((s) => s.resetDetected)
		.map((s) => `[${s.trueLimitMiB[0]}, ${s.trueLimitMiB[1]})`);
	console.log(`  true-limit intervals ${[...new Set(intervals)].join(' ') || 'none'}`);
	if (replay.length) {
		console.log(
			`  replay last good total MiB ${replay.map((s) => s.lastGoodTotalMiB).join(', ')} (resets ${replay.filter((s) => s.resetDetected).length}/${replay.length})`
		);
	}
}

const ladder = summaries.filter((s) => s.family !== 'burst' && s.family !== 'calibration');
const reads = rows.filter((r) => r.op === 'read');
const crossings = ladder.filter((s) => s.resetDetected);
const extras = crossings.map((s) => s.counterAfter - s.ackedBallast);
const tokens = crossings.map((s) => s.crossingTokenRows);
const anomalies = reads.filter((r) => {
	const s = byObject.get(r.object);
	return s && !s.resetDetected && r.counter !== r.ackedBallast;
});
console.log('double execution');
console.log(`  ladder objects ${ladder.length}, crossings ${crossings.length}`);
console.log(
	`  counter minus acknowledged ballast calls at crossing: ${JSON.stringify(tally(extras))}`
);
console.log(`  crossing token rows: ${JSON.stringify(tally(tokens))}`);
console.log(`  non-crossing read anomalies (counter != acknowledged): ${anomalies.length}`);

const ballastRows = rows.filter((r) => r.op === 'ballast' && r.phase === 'main');
const coRes = ballastRows.filter((r) => (r.others ?? 0) >= 1).length;
console.log(
	`co-residence: ${coRes}/${ballastRows.length} main ballast calls saw another object in the isolate`
);

const calib = rows.filter((r) => r.phase === 'calibration' && r.op === 'ping');
console.log(
	`calibration idle pings: n=${calib.length}, linear MiB ${[...new Set(calib.map((r) => r.linearMiB))].join(', ')}, ` +
		`ballast MiB ${[...new Set(calib.map((r) => r.ballastMiB))].join(', ')}, bytes ${stats(calib.map((r) => r.bytes))}`
);

const mainLadder = ladder.filter((s) => s.phase === 'main' && s.lastGoodTotalMiB != null);
const r = pearson(
	mainLadder.map((s) => s.runIndex),
	mainLadder.map((s) => {
		const cellMates = mainLadder
			.filter((m) => m.cell === s.cell)
			.map((m) => m.lastGoodTotalMiB);
		const mean = cellMates.reduce((a, b) => a + b, 0) / cellMates.length;
		return s.lastGoodTotalMiB - mean;
	})
);
console.log(
	`order effect: Pearson r of run index vs total minus cell mean = ${r === null ? 'not computed' : r.toFixed(3)} (n=${mainLadder.length})`
);

function tally(xs) {
	const out = {};
	for (const x of xs) out[x] = (out[x] ?? 0) + 1;
	return out;
}
