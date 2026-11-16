import { readFileSync } from 'node:fs';

const results = JSON.parse(readFileSync(process.argv[2] ?? 'results.json', 'utf8'));
const sum = (h) => Object.values(h).reduce((a, b) => a + b, 0);
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const row = (label, hitsList) => {
	const n = hitsList.length;
	if (!n) return `| ${label} | 0 | - | - | - | - |`;
	const totals = hitsList.map(sum);
	const paths = {};
	for (const h of hitsList) for (const p of Object.keys(h)) paths[p] = (paths[p] ?? 0) + 1;
	const list =
		Object.entries(paths)
			.map(([p, c]) => `${p} (${c}/${n})`)
			.join(', ') || 'none';
	return `| ${label} | ${n} | ${Math.min(...totals)} | ${median(totals)} | ${Math.max(...totals)} | ${list} |`;
};
for (const [browser, runs] of Object.entries(results)) {
	console.log(`\n### ${browser} (measured, n=${runs.length})\n`);
	console.log(
		'| case | n | min | median | max | origin paths seen (runs) |\n| --- | --- | --- | --- | --- | --- |'
	);
	const pick = (arm, key) => runs.map((r) => r[arm]?.[key]).filter(Boolean);
	for (const arm of ['spool', 'control', 'spoolNoStore', 'controlNoStore']) {
		for (const key of [
			'second',
			'revisit',
			'fresh',
			'reload',
			'bypassReload',
			'keyboardReload',
			'unlisted'
		]) {
			const l = pick(arm, key);
			if (l.length) console.log(row(`${arm} ${key}`, l));
		}
	}
	for (const arm of ['kill', 'killNoCache']) {
		const ok = runs.filter((r) => !r[arm].error);
		const count = (f) => ok.filter(f).length;
		console.log(
			`\n${arm} (n=${ok.length}): worker unregistered after nav1: ${count((r) => r[arm].regsAfterNav1 === 0)}, after nav2: ${count((r) => r[arm].regsAfterNav2 === 0)}; /spool-sw.js fetched in nav1: ${count((r) => r[arm].nav1['/spool-sw.js'])}; nav3 reached origin: ${count((r) => sum(r[arm].nav3) > 0)}; client tag in DOM after nav3: ${count((r) => r[arm].tagInDom)}`
		);
	}
	const errs = runs.flatMap((r) =>
		Object.values(r)
			.filter((v) => v?.error)
			.map((v) => v.error)
	);
	if (errs.length) console.log(`\nerrors: ${errs.join(' | ')}`);
}
