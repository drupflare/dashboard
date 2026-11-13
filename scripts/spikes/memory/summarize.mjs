import { readFileSync } from 'node:fs';

const rows = readFileSync(new URL('./sandbox-rows.jsonl', import.meta.url), 'utf8')
	.trim()
	.split('\n')
	.map((line) => JSON.parse(line));

function stats(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
	return { n, median, min: s[0], max: s[n - 1] };
}

function fmt(st, digits = 1) {
	return `n=${st.n} median ${st.median.toFixed(digits)} range ${st.min.toFixed(digits)} to ${st.max.toFixed(digits)}`;
}

const climbs = new Map();
const externals = new Map();
for (const r of rows) {
	const flags = r.execArgv?.length ? r.execArgv.join(' ') : 'default';
	if ('climbCpuMs' in r) {
		const key = `${r.node} ${flags}`;
		if (!climbs.has(key)) climbs.set(key, []);
		climbs.get(key).push(r);
	} else {
		if (!externals.has(r.node)) externals.set(r.node, []);
		externals.get(r.node).push(r);
	}
}

console.log('climb: peak RSS (maxRSS KB / 1024, MiB), climb CPU ms, climb wall ms');
for (const [key, rs] of climbs) {
	console.log(`${key}`);
	console.log(`  peakRSS MiB   ${fmt(stats(rs.map((r) => r.maxRSSRaw / 1024)))}`);
	console.log(`  climbCpu ms   ${fmt(stats(rs.map((r) => r.climbCpuMs)))}`);
	console.log(`  climbWall ms  ${fmt(stats(rs.map((r) => r.climbWallMs)))}`);
	console.log(`  rssEnd MiB    ${fmt(stats(rs.map((r) => r.rssEndMiB)))}`);
}

const movingKey = (node) => `${node} --stress-wasm-memory-moving`;
for (const node of ['v22.23.3', 'v24.21.0']) {
	const def = climbs.get(`${node} default`);
	const mov = climbs.get(movingKey(node));
	if (def && mov) {
		const d = stats(def.map((r) => r.climbCpuMs)).median;
		const m = stats(mov.map((r) => r.climbCpuMs)).median;
		console.log(`${node} moving/default climb CPU median ratio ${(m / d).toFixed(2)}`);
	}
}

console.log('external: process.memoryUsage() deltas for one 64 MiB wasm memory (MiB)');
for (const [node, rs] of externals) {
	console.log(`${node}`);
	console.log(
		`  delta external after create    ${fmt(stats(rs.map((r) => r.deltaExternalCreateMiB)), 2)}`
	);
	console.log(
		`  delta arrayBuffers after create ${fmt(stats(rs.map((r) => r.deltaArrayBuffersCreateMiB)), 2)}`
	);
	console.log(
		`  absolute external after create  ${fmt(stats(rs.map((r) => r.afterCreate.external)), 2)}`
	);
	console.log(
		`  delta external after touch      ${fmt(stats(rs.map((r) => r.deltaExternalTouchMiB)), 2)}`
	);
}
