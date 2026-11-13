import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'rows.jsonl';
const rows = readFileSync(new URL(file, import.meta.url), 'utf8')
	.trim()
	.split('\n')
	.filter(Boolean)
	.map((line) => JSON.parse(line));

function stats(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	if (n === 0) return null;
	const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
	return { n, median, min: s[0], max: s[n - 1] };
}

const fmt = (st) =>
	st
		? `n=${st.n} median ${st.median.toFixed(1)} range ${st.min.toFixed(1)} to ${st.max.toFixed(1)}`
		: 'n=0';

const byCell = new Map();
for (const r of rows) {
	if (!byCell.has(r.cell)) byCell.set(r.cell, new Map());
	const objs = byCell.get(r.cell);
	if (!objs.has(r.object)) objs.set(r.object, []);
	objs.get(r.object).push(r);
}

for (const [cell, objs] of byCell) {
	const perObject = [];
	const errors = new Set();
	for (const [object, rs] of objs) {
		const resetRows = rs.filter((r) => r.resetDetected === true);
		for (const f of rs.filter((r) => r.ok === false && r.error)) errors.add(f.error);
		const summary = rs.find((r) => r.op === 'summary');
		const init = rs.find((r) => r.op === 'init' && r.ok);
		let lastGood = 0;
		let lastLinear = init ? init.linearMiB : null;
		for (const r of rs) {
			if (r.resetDetected === true) break;
			if (r.ok && r.linearMiB != null) lastLinear = r.linearMiB;
			if (r.op === 'ballast' && r.ok) lastGood = r.ballastMiB;
		}
		const pingsOk = rs.filter(
			(r) => r.op === 'ping' && r.holdInvocation && r.ok && r.resetDetected !== true
		).length;
		const pingsTotal = rs.filter((r) => r.op === 'ping' && r.holdInvocation).length;
		const burst = rs.find((r) => r.op === 'burst');
		const others = rs
			.filter((r) => r.ok && r.others != null && r.resetDetected !== true)
			.map((r) => r.others);
		perObject.push({
			object,
			reset: resetRows.length > 0,
			lastGoodBallast: summary ? summary.lastOkMb : lastGood,
			linear: lastLinear,
			pingsOk,
			pingsTotal,
			burstOk: burst ? burst.ok && burst.resetDetected !== true : null,
			maxOthers: others.length ? Math.max(...others) : null
		});
	}

	const n = perObject.length;
	const resets = perObject.filter((o) => o.reset).length;
	const ballast = stats(perObject.map((o) => o.lastGoodBallast));
	const linear = stats(perObject.map((o) => o.linear).filter((v) => v != null));
	const total = stats(
		perObject.filter((o) => o.linear != null).map((o) => o.linear + o.lastGoodBallast)
	);
	const coRes = perObject.filter((o) => o.maxOthers != null && o.maxOthers >= 1).length;
	const pingsOk = perObject.reduce((a, o) => a + o.pingsOk, 0);
	const pingsTotal = perObject.reduce((a, o) => a + o.pingsTotal, 0);
	const burstOk = perObject.filter((o) => o.burstOk === true).length;
	const burstTotal = perObject.filter((o) => o.burstOk !== null).length;

	console.log(`cell ${cell}`);
	console.log(`  objects ${n}, reset detected ${resets}`);
	console.log(`  linear MiB ${fmt(linear)}`);
	console.log(`  last good ballast MiB before reset ${fmt(ballast)}`);
	console.log(`  linear + last good ballast MiB ${fmt(total)}`);
	if (pingsTotal) console.log(`  held pings ok ${pingsOk}/${pingsTotal}`);
	if (burstTotal) console.log(`  burst ok ${burstOk}/${burstTotal}`);
	console.log(`  objects with a neighbour seen (others >= 1) ${coRes}/${n}`);
	if (errors.size) console.log(`  error texts ${[...errors].join(' | ')}`);
}
