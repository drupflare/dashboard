import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Shot {
	route: string;
	file: string;
}

// public pages only; signed-in screens need a seeded user and are not in this list yet
export const SHOTS: readonly Shot[] = [
	{ route: '/docs', file: 'docs-home.png' },
	{ route: '/docs/start/create-your-first-site', file: 'create-your-first-site.png' },
	{ route: '/trust', file: 'trust-center.png' }
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// a page file answers the route its path names; [x] takes one segment, [...x] and [[...x]] take
// zero or more, and (group) folders do not appear in the URL
export function pageFileRegex(file: string): RegExp {
	const segments = file
		.replace(/\.vue$/, '')
		.split('/')
		.filter((segment) => !/^\(.*\)$/.test(segment))
		.filter((segment) => segment !== 'index');
	const parts = segments.map((segment) => {
		if (/^\[\.\.\..+\]$/.test(segment) || /^\[\[\.\.\..+\]\]$/.test(segment)) {
			return '(?:/.*)?';
		}
		if (/^\[.+\]$/.test(segment)) return '/[^/]+';
		return `/${escape(segment)}`;
	});
	return new RegExp(`^${parts.join('')}/?$`);
}

export function routeExists(route: string, pageFiles: readonly string[]): boolean {
	return pageFiles.some((file) => pageFileRegex(file).test(route));
}

export function missingRoutes(shots: readonly Shot[], pageFiles: readonly string[]): string[] {
	return shots.filter((shot) => !routeExists(shot.route, pageFiles)).map((shot) => shot.route);
}

async function listPageFiles(dir: string, base = dir): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listPageFiles(full, base)));
		else if (entry.name.endsWith('.vue')) out.push(relative(base, full).split('\\').join('/'));
	}
	return out;
}

async function main(): Promise<void> {
	const pagesDir = fileURLToPath(new URL('../src/pages/', import.meta.url));
	const missing = missingRoutes(SHOTS, await listPageFiles(pagesDir));
	if (missing.length > 0) {
		throw new Error(`screenshot routes no longer exist: ${missing.join(', ')}`);
	}
	const { chromium } = await import('@playwright/test');
	const base = process.env.SHOTS_BASE_URL ?? 'http://127.0.0.1:8787';
	const out = fileURLToPath(new URL('../docs/img/', import.meta.url));
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		for (const shot of SHOTS) {
			await page.goto(new URL(shot.route, base).toString());
			await page.screenshot({ path: join(out, shot.file), fullPage: true });
			console.log(`wrote docs/img/${shot.file}`);
		}
	} finally {
		await browser.close();
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await main();
}
