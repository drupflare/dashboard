// Readability table for Markdown pages. Run: bun scripts/docs-readability.ts docs/start docs/index.md
// Measuring tool only: no thresholds, no CI wiring.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

// matched as whole words, optional plural s; add a term here, not in the prose checks
export const JARGON = [
	'lease',
	'epoch',
	'shard',
	'Durable Object',
	'namespace',
	'idempotent',
	'tombstone',
	'quorum',
	'binding',
	'principal',
	'scope',
	'entitlement',
	'reconcile',
	'reconciliation',
	'ring',
	'cohort',
	'manifest',
	'quarantine',
	'egress',
	'ingress',
	'bastion',
	'cutover',
	'showback',
	'chargeback',
	'webhook',
	'idempotent',
	'idempotency',
	'route class',
	'discovery document',
	'provenance',
	'OpenID Connect',
	'OpenAPI',
	'CAA',
	'R2',
	'operation',
	'workflow',
	'point-in-time',
	'replica',
	'isolate',
	'bookmark',
	'rollback guard',
	'break glass',
	'subprocessor',
	'entitlement'
];

export interface PageStats {
	words: number;
	sentences: number;
	syllables: number;
	longest: number;
	grade: number | null;
	jargon: number;
}

// Flesch-Kincaid grade = 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59.
// Syllables use a vowel-group heuristic: drop a silent trailing e (and -es, -ed), leading y is
// not a vowel, each run of up to two vowels counts once, and words of three letters or fewer
// count as one syllable. Headings and list items count as sentences of their own.
export function syllables(word: string): number {
	const w = word.toLowerCase().replace(/[^a-z]/g, '');
	if (w.length === 0) return 0;
	if (w.length <= 3) return 1;
	const body = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
	const groups = body.match(/[aeiouy]{1,2}/g);
	return Math.max(1, groups ? groups.length : 1);
}

export function fleschKincaid(words: number, sentences: number, syl: number): number | null {
	if (words === 0 || sentences === 0) return null;
	return 0.39 * (words / sentences) + 11.8 * (syl / words) - 15.59;
}

// Strip frontmatter, fenced code, tables, comments, MDC block markers, images and link targets.
// Keeps the visible text of links and inline code.
export function prose(markdown: string): string {
	const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
	const kept: string[] = [];
	let fence: string | null = null;
	for (const line of body.split('\n')) {
		const open = /^\s*(```|~~~)/.exec(line);
		if (open) {
			if (fence === null) fence = open[1] ?? null;
			else if (open[1] === fence) fence = null;
			continue;
		}
		if (fence !== null || /^\s*\|/.test(line) || /^\s*:{2,}/.test(line)) continue;
		kept.push(line);
	}
	return kept
		.join('\n')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, ' ')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/\*/g, '')
		.replace(/^\s*#{1,6}\s+/gm, '')
		.replace(/^\s*(?:[-+]|\d+[.)])\s+/gm, '')
		.replace(/^\s*>+\s?/gm, '');
}

// One entry per sentence; a line with no end punctuation is a sentence of its own.
export function sentencesOf(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split('\n')) {
		const protectedLine = line.replace(/\b(e\.g|i\.e)\./gi, '$1');
		for (const part of protectedLine.split(/(?<=[.!?])["')\]]*\s+/)) {
			if (/[A-Za-z0-9]/.test(part)) out.push(part.trim());
		}
	}
	return out;
}

export function wordsOf(text: string): string[] {
	return text.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t));
}

export function jargonHits(text: string): number {
	let hits = 0;
	for (const term of JARGON) {
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
		hits += (text.match(new RegExp(`\\b${escaped}(?:s)?\\b`, 'gi')) ?? []).length;
	}
	return hits;
}

export function analyse(markdown: string): PageStats {
	const text = prose(markdown);
	const words = wordsOf(text);
	const sentences = sentencesOf(text);
	const syl = words.reduce((sum, w) => sum + syllables(w), 0);
	const longest = sentences.reduce((max, s) => Math.max(max, wordsOf(s).length), 0);
	return {
		words: words.length,
		sentences: sentences.length,
		syllables: syl,
		longest,
		grade: fleschKincaid(words.length, sentences.length, syl),
		jargon: jargonHits(text)
	};
}

export function pool(stats: PageStats[]): PageStats {
	const total = stats.reduce(
		(acc, s) => ({
			words: acc.words + s.words,
			sentences: acc.sentences + s.sentences,
			syllables: acc.syllables + s.syllables,
			longest: Math.max(acc.longest, s.longest),
			grade: null as number | null,
			jargon: acc.jargon + s.jargon
		}),
		{ words: 0, sentences: 0, syllables: 0, longest: 0, grade: null, jargon: 0 } as PageStats
	);
	total.grade = fleschKincaid(total.words, total.sentences, total.syllables);
	return total;
}

async function markdownUnder(path: string): Promise<string[]> {
	const info = await stat(path);
	if (info.isFile()) return path.endsWith('.md') ? [path] : [];
	const found: string[] = [];
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) found.push(...(await markdownUnder(child)));
		else if (entry.name.endsWith('.md')) found.push(child);
	}
	return found.sort();
}

function row(file: string, s: PageStats): string {
	const grade = s.grade === null ? '-' : s.grade.toFixed(1);
	const avg = s.sentences === 0 ? '-' : (s.words / s.sentences).toFixed(1);
	return `| ${file} | ${s.words} | ${avg} | ${s.longest} | ${grade} | ${s.jargon} |`;
}

export function sentencesOver(markdown: string, limit: number): string[] {
	return sentencesOf(prose(markdown)).filter((s) => wordsOf(s).length > limit);
}

export function splitArgs(argv: string[]): { limit: number | null; args: string[] } {
	const overAt = argv.indexOf('--over');
	if (overAt === -1) return { limit: null, args: argv };
	return {
		limit: Number(argv[overAt + 1]),
		args: argv.filter((_, i) => i !== overAt && i !== overAt + 1)
	};
}

async function main(argv: string[]): Promise<void> {
	const { limit, args } = splitArgs(argv);
	if (args.length === 0) {
		console.error('usage: bun scripts/docs-readability.ts [--over N] <dir-or-file>...');
		process.exit(2);
	}
	const root = process.cwd();
	for (const arg of args) {
		const files = await markdownUnder(arg);
		const stats: PageStats[] = [];
		const rows: string[] = [];
		for (const file of files) {
			const text = await readFile(file, 'utf8');
			const s = analyse(text);
			stats.push(s);
			rows.push(row(relative(root, file), s));
			if (limit !== null) {
				for (const long of sentencesOver(text, limit)) {
					rows.push(
						`>   ${relative(root, file)} (${wordsOf(long).length} words): ${long}`
					);
				}
			}
		}
		const total = pool(stats);
		const meanGrade =
			stats.filter((s) => s.grade !== null).reduce((sum, s) => sum + (s.grade ?? 0), 0) /
			Math.max(1, stats.filter((s) => s.grade !== null).length);
		console.log(`## ${arg} (${files.length} pages)\n`);
		console.log('| page | words | avg sentence | longest | grade | jargon |');
		console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
		for (const r of rows) console.log(r);
		console.log(
			`| **total** | ${total.words} | ${(total.words / Math.max(1, total.sentences)).toFixed(1)} | ${total.longest} | ${total.grade === null ? '-' : total.grade.toFixed(1)} (pooled), ${meanGrade.toFixed(1)} (mean of pages) | ${total.jargon} |`
		);
		console.log('');
	}
}

if (process.argv[1]?.endsWith('docs-readability.ts')) {
	await main(process.argv.slice(2));
}
