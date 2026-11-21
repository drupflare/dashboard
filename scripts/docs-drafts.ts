import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

// route paths (/docs, /docs/guides/x) of every page whose frontmatter says draft: true
export function draftDocRoutes(
	root = fileURLToPath(new URL('../docs/', import.meta.url))
): string[] {
	const routes: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(full);
				continue;
			}
			if (!entry.name.endsWith('.md')) continue;
			const match = readFileSync(full, 'utf8').match(FRONTMATTER);
			if (!match || parse(match[1]!).draft !== true) continue;
			const rel = relative(root, full).split('\\').join('/').replace(/\.md$/, '');
			routes.push(rel === 'index' ? '/docs' : `/docs/${rel}`);
		}
	};
	visit(root);
	return routes.sort();
}
