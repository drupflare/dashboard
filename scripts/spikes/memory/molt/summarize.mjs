import { readFileSync } from 'node:fs';

const mode = process.argv[2];
if (mode !== 'local' && mode !== 'v3') throw new Error('usage: summarize.mjs local|v3');
const file = new URL(mode === 'v3' ? './rows-v3.jsonl' : './rows-local.jsonl', import.meta.url);
const rows = readFileSync(file, 'utf8')
	.trim()
	.split('\n')
	.filter(Boolean)
	.map((line) => JSON.parse(line));

function median(xs) {
	const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
	if (!s.length) return null;
	const n = s.length;
	return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const mib = (kib) => (kib === null ? 'n/a' : (kib / 1024).toFixed(1));

function localSummary() {
	const units = new Map();
	for (const r of rows) {
		if (!r.unit) continue;
		if (!units.has(r.unit)) units.set(r.unit, { rss: [], events: [] });
		const u = units.get(r.unit);
		if (r.type === 'rss') u.rss.push({ t: r.t, kib: r.rssKiB });
		if (r.type === 'event') u.events.push(r);
	}
	const cells = new Map();
	for (const [id, u] of units) {
		const ev = (name) => u.events.find((e) => e.name === name);
		const actionEnd = ev('action-end');
		const atEnd = actionEnd
			? (u.rss.filter((s) => s.t <= actionEnd.t).at(-1)?.kib ?? null)
			: null;
		const fall =
			actionEnd && atEnd !== null
				? u.rss.find((s) => s.t >= actionEnd.t && s.kib <= atEnd - 16 * 1024)
				: undefined;
		const before = ev('ping-before-abort');
		const after = ev('ping-after-abort');
		const action = u.events.find(
			(e) => e.name === 'action' && e.copyMs !== undefined && e.copyMs !== null
		);
		const cell = id.replace(/-\d+$/, '');
		const rec = {
			id,
			baseline: u.rss[0]?.kib ?? null,
			peak: u.rss.length ? Math.max(...u.rss.map((s) => s.kib)) : null,
			atEnd,
			final: u.rss.at(-1)?.kib ?? null,
			fallS: fall ? (fall.t - actionEnd.t) / 1000 : null,
			droppedAlive: ev('ping-mid')?.droppedAlive ?? null,
			evictedBeforeFinal:
				ev('ping-mid') && ev('ping-final')
					? ev('ping-mid').incarnation !== ev('ping-final').incarnation
					: null,
			copyMs: action?.copyMs ?? null,
			incarnationChanged: before && after ? before.incarnation !== after.incarnation : null,
			isolateChanged: before && after ? before.isolate !== after.isolate : null,
			abortError: ev('action')?.error ?? null,
			workerdGone: ev('stopped')?.workerdGone ?? null,
			error: ev('error')?.error ?? null
		};
		if (!cells.has(cell)) cells.set(cell, []);
		cells.get(cell).push(rec);
	}
	for (const [cell, list] of cells) {
		const fell = list.filter((r) => r.fallS !== null);
		console.log(`${cell}: n=${list.length}`);
		console.log(
			`  RSS MiB median: baseline ${mib(median(list.map((r) => r.baseline)))}, ` +
				`peak ${mib(median(list.map((r) => r.peak)))}, at action end ${mib(median(list.map((r) => r.atEnd)))}, ` +
				`final ${mib(median(list.map((r) => r.final)))}`
		);
		console.log(
			`  RSS fell >=16 MiB after action end in ${fell.length}/${list.length}` +
				(fell.length ? ` (median time ${median(fell.map((r) => r.fallS))} s)` : '')
		);
		console.log(
			`  object view at mid ping (5 s): droppedAlive ${JSON.stringify(list.map((r) => r.droppedAlive))}; ` +
				`evicted between mid and final ping ${list.filter((r) => r.evictedBeforeFinal).length}/${list.length}`
		);
		if (list.some((r) => r.copyMs !== null)) {
			console.log(
				`  copy ms: ${list.map((r) => r.copyMs?.toFixed(1)).join(', ')} (median ${median(list.map((r) => r.copyMs))?.toFixed(1)})`
			);
		}
		if (list.some((r) => r.incarnationChanged !== null)) {
			console.log(
				`  abort: incarnation changed ${list.filter((r) => r.incarnationChanged).length}/${list.length}, ` +
					`isolate changed ${list.filter((r) => r.isolateChanged).length}/${list.length}, ` +
					`error ${JSON.stringify(list.map((r) => r.abortError))}`
			);
		}
		const errs = list.filter((r) => r.error || r.workerdGone === false);
		if (errs.length) console.log(`  unit errors or leftover workerd: ${JSON.stringify(errs)}`);
	}
	const manifest = rows.find((r) => r.type === 'manifest');
	if (manifest) console.log(`manifest: units ${manifest.units}, seed ${manifest.seed}`);
}

function v3Summary() {
	const sums = rows.filter((r) => r.type === 'summary');
	const pilot = sums.find((s) => s.pilot);
	console.log(
		`pilot: failure ${pilot?.failure ?? 'none'}, last good MiB ${pilot?.lastGoodMiB ?? 'n/a'}`
	);
	const byArm = new Map();
	for (const s of sums.filter((x) => !x.pilot)) {
		if (!byArm.has(s.arm)) byArm.set(s.arm, []);
		byArm.get(s.arm).push(s);
	}
	for (const [arm, list] of byArm) {
		const totals = list.map((s) => s.lastGoodMiB).filter((x) => x !== undefined && x !== null);
		const failures = list.filter((s) => s.failure).map((s) => s.failure);
		console.log(`arm ${arm}: n=${list.length}`);
		console.log(
			`  failures: ${failures.length} (${[...new Set(failures)].join(', ') || 'none'})`
		);
		console.log(`  molt-step resets: ${list.filter((s) => s.moltResetAt).length}`);
		console.log(`  idle evictions (30 s idle): ${list.filter((s) => s.idleEvicted).length}`);
		console.log(`  alarm abort observed: ${list.filter((s) => s.alarmObserved).length}`);
		console.log(
			`  reachable last good total MiB: ${totals.join(', ') || 'none'} (median ${median(totals) ?? 'n/a'})`
		);
		console.log(`  climb cap reached: ${list.filter((s) => s.capReached).length}`);
	}
	const calls = rows.filter((r) => r.type === 'call');
	const medianMs = median(calls.map((c) => c.ms));
	console.log(`calls: ${calls.length}, median call ms ${medianMs}`);
	console.log(
		`resets seen on calls: ${calls.filter((c) => c.resetDetected).length} (expected ${calls.filter((c) => c.expectedReset).length})`
	);
}

if (mode === 'local') localSummary();
else v3Summary();
