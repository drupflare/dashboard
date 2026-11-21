import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGES = fileURLToPath(new URL('../../src/pages', import.meta.url));

export interface StaticRoute {
	path: string;
	// pages without a declared layout use the signed-in default layout
	layout: 'default' | 'public' | 'auth';
}

function layoutOf(file: string): StaticRoute['layout'] {
	const match = /layout:\s*'(public|auth)'/.exec(readFileSync(file, 'utf8'));
	return match?.[1] === 'public' || match?.[1] === 'auth' ? match[1] : 'default';
}

// every static route in src/pages; dynamic segments ([id], [...slug]) need a real record, so they are skipped
export function staticRoutes(dir = PAGES): StaticRoute[] {
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry): StaticRoute[] => {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) return staticRoutes(full);
			if (!entry.name.endsWith('.vue')) return [];
			const segments = relative(PAGES, full)
				.split(sep)
				.map((part) => part.replace(/\.vue$/, ''));
			if (segments.some((part) => part.includes('['))) return [];
			if (segments.at(-1) === 'index') segments.pop();
			return [{ path: `/${segments.join('/')}`, layout: layoutOf(full) }];
		})
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
