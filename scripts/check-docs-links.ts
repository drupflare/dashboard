import { readdir, readFile } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LinkProblem {
	file: string;
	line: number;
	target: string;
	reason: 'missing file' | 'missing anchor';
}

const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function anchorOf(heading: string): string {
	return heading
		.replace(/<[^>]+>/g, '')
		.replace(/[`*_]/g, '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9 -]/g, '')
		.replace(/ /g, '-');
}

// lines outside fenced code blocks, with their 1-based numbers
function proseLines(text: string): { no: number; text: string }[] {
	const out: { no: number; text: string }[] = [];
	let fenced = false;
	text.split('\n').forEach((line, index) => {
		if (FENCE.test(line)) {
			fenced = !fenced;
			return;
		}
		if (!fenced) out.push({ no: index + 1, text: line });
	});
	return out;
}

export function anchorsOf(text: string): Set<string> {
	const anchors = new Set<string>();
	for (const line of proseLines(text)) {
		const heading = line.text.match(HEADING);
		if (heading) anchors.add(anchorOf(heading[1]!));
	}
	return anchors;
}

// the mirrored sites live under these routes; their pages are not files in this repo
const MIRROR_ROUTE = /^\/docs\/(worker|spool)(\/|$)/;

// maps a /docs/... target to the file it names; null when the target is not a docs link
function docsTargetFile(target: string): string | null {
	const path = target.split('#')[0]!.split('?')[0]!;
	if (path === '/docs') return 'index.md';
	if (MIRROR_ROUTE.test(path)) return null;
	if (!path.startsWith('/docs/')) return null;
	const rest = path.slice('/docs/'.length);
	return posix.extname(rest) ? rest : `${rest}.md`;
}

// files: docs-relative path to text, e.g. "guides/billing/plans.md"
export function checkDocsLinks(files: ReadonlyMap<string, string>): LinkProblem[] {
	const anchors = new Map<string, Set<string>>();
	for (const [file, text] of files) anchors.set(file, anchorsOf(text));
	const problems: LinkProblem[] = [];

	for (const [file, text] of files) {
		for (const line of proseLines(text)) {
			for (const match of line.text.matchAll(LINK)) {
				const target = match[1]!;
				if (/^[a-z]+:/i.test(target)) continue;
				const [pathPart, hash] = target.split('#') as [string, string | undefined];
				let targetFile: string | null;
				if (pathPart === '') targetFile = file;
				else if (pathPart.startsWith('/')) targetFile = docsTargetFile(pathPart);
				else {
					targetFile = posix.normalize(posix.join(posix.dirname(file), pathPart));
				}
				if (targetFile === null) continue;
				if (targetFile.startsWith('..')) {
					problems.push({ file, line: line.no, target, reason: 'missing file' });
					continue;
				}
				if (!files.has(targetFile)) {
					problems.push({ file, line: line.no, target, reason: 'missing file' });
					continue;
				}
				if (hash && !anchors.get(targetFile)?.has(hash)) {
					problems.push({ file, line: line.no, target, reason: 'missing anchor' });
				}
			}
		}
	}
	return problems;
}

async function walk(root: string, dir = root): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(root, full)));
		else out.push(relative(root, full).split('\\').join('/'));
	}
	return out;
}

interface MirrorNodeLike {
	t?: string;
	href?: string;
	src?: string;
	id?: string;
	c?: unknown[];
}

export interface MirrorProblem {
	mirror: string;
	page: string;
	target: string;
	reason: 'missing page' | 'missing anchor' | 'missing image';
}

// every link between mirrored pages and every image must resolve inside the mirror
export function checkMirrorLinks(
	mirror: { id: string; routePrefix: string },
	pages: ReadonlyMap<string, { nodes: unknown[] }>,
	assets: ReadonlySet<string>
): MirrorProblem[] {
	const ids = new Map<string, Set<string>>();
	const visit = (nodes: unknown[], fn: (node: MirrorNodeLike) => void) => {
		for (const node of nodes) {
			if (typeof node !== 'object' || node === null) continue;
			fn(node as MirrorNodeLike);
			if (Array.isArray((node as MirrorNodeLike).c)) visit((node as MirrorNodeLike).c!, fn);
		}
	};
	for (const [key, page] of pages) {
		const found = new Set<string>();
		visit(page.nodes, (node) => node.t === 'h' && node.id && found.add(node.id));
		ids.set(key, found);
	}
	const problems: MirrorProblem[] = [];
	const assetPrefix = `${mirror.routePrefix}/_assets/`;
	for (const [key, page] of pages) {
		const add = (target: string, reason: MirrorProblem['reason']) =>
			problems.push({ mirror: mirror.id, page: key, target, reason });
		visit(page.nodes, (node) => {
			if (node.t === 'img' && node.src?.startsWith(assetPrefix)) {
				if (!assets.has(node.src.slice(assetPrefix.length))) add(node.src, 'missing image');
			}
			if (node.t !== 'a' || !node.href) return;
			const [path = '', hash] = node.href.split('#') as [string, string | undefined];
			const inMirror =
				path === mirror.routePrefix || path.startsWith(`${mirror.routePrefix}/`);
			if (path !== '' && !inMirror) return;
			if (path.startsWith(assetPrefix)) {
				if (!assets.has(path.slice(assetPrefix.length))) add(node.href, 'missing image');
				return;
			}
			const target = path === '' ? key : path.slice(mirror.routePrefix.length + 1);
			if (!pages.has(target)) return add(node.href, 'missing page');
			if (hash && !ids.get(target)?.has(decodeURIComponent(hash)))
				add(node.href, 'missing anchor');
		});
	}
	return problems;
}

// online mode: downloads each mirrored repo and checks the pages the dashboard would serve; never runs in CI
async function mainOnline(): Promise<number> {
	const mirrorsPath = '../src/shared/doc-mirrors';
	const servicePath = '../src/server/services/doc-mirror';
	const { DOC_MIRRORS, MIRROR_LIMITS } = await import(mirrorsPath);
	const { buildMirror, extractDocs, commitOf, inflateCapped } = await import(servicePath);
	let total = 0;
	for (const mirror of DOC_MIRRORS) {
		const response = await fetch(
			`https://codeload.github.com/${mirror.repo}/tar.gz/${mirror.ref}`,
			{ redirect: 'error' }
		);
		if (!response.ok) throw new Error(`${mirror.repo}: GitHub answered ${response.status}`);
		const tar = await inflateCapped(
			new Uint8Array(await response.arrayBuffer()),
			MIRROR_LIMITS.inflatedBytes
		);
		const built = buildMirror(mirror, commitOf(tar) ?? 'unknown', extractDocs(tar, mirror));
		const problems = checkMirrorLinks(mirror, built.pages, new Set(built.assets.keys()));
		for (const p of problems) console.error(`${p.mirror}:${p.page} ${p.reason}: ${p.target}`);
		for (const skipped of built.meta.skipped) console.error(`${mirror.id} skipped ${skipped}`);
		console.log(`${mirror.id}: ${built.pages.size} pages, ${problems.length} problem(s)`);
		total += problems.length;
	}
	return total === 0 ? 0 : 1;
}

// assets (images) are present as keys with empty text, so a link to one resolves
async function main(): Promise<number> {
	const root = fileURLToPath(new URL('../docs/', import.meta.url));
	const files = new Map<string, string>();
	for (const file of await walk(root)) {
		files.set(file, file.endsWith('.md') ? await readFile(join(root, file), 'utf8') : '');
	}
	const problems = checkDocsLinks(files);
	for (const p of problems) console.error(`docs/${p.file}:${p.line} ${p.reason}: ${p.target}`);
	console.log(`checked ${files.size} pages, ${problems.length} problem(s)`);
	return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exitCode = process.argv.includes('--online') ? await mainOnline() : await main();
}
