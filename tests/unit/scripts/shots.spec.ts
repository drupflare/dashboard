import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { missingRoutes, pageFileRegex, routeExists, SHOTS } from '../../../scripts/shots';

const pagesDir = fileURLToPath(new URL('../../../src/pages/', import.meta.url));

function pageFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return pageFiles(full);
		return entry.name.endsWith('.vue') ? [relative(pagesDir, full).split('\\').join('/')] : [];
	});
}

describe('screenshot route check', () => {
	it('matches a static page and its index', () => {
		expect(routeExists('/trust', ['trust.vue'])).toBe(true);
		expect(routeExists('/trust/x', ['trust.vue'])).toBe(false);
		expect(routeExists('/', ['index.vue'])).toBe(true);
		expect(routeExists('/docs', ['docs/index.vue'])).toBe(true);
	});

	it('matches one segment for a dynamic page and any depth for a catch-all', () => {
		expect(routeExists('/sites/s1', ['sites/[id]/index.vue'])).toBe(true);
		expect(routeExists('/sites', ['sites/[id]/index.vue'])).toBe(false);
		expect(routeExists('/sites/s1/a', ['sites/[id]/index.vue'])).toBe(false);
		expect(routeExists('/docs/a/b', ['docs/[...slug].vue'])).toBe(true);
		expect(routeExists('/docs', ['docs/[...slug].vue'])).toBe(true);
	});

	it('ignores a group folder, which is not in the URL', () => {
		expect(pageFileRegex('(public)/trust.vue').test('/trust')).toBe(true);
	});

	it('does not treat a dot in a literal name as a wildcard', () => {
		expect(routeExists('/a1b', ['a.b.vue'])).toBe(false);
	});

	it('names each shot whose route no longer has a page', () => {
		const files = ['trust.vue', 'docs/[...slug].vue'];
		expect(
			missingRoutes(
				[
					{ route: '/trust', file: 'a.png' },
					{ route: '/docs/start', file: 'b.png' },
					{ route: '/gone', file: 'c.png' }
				],
				files
			)
		).toEqual(['/gone']);
	});

	it('finds every route the shot list names in the real pages folder', () => {
		expect(missingRoutes(SHOTS, pageFiles(pagesDir))).toEqual([]);
	});
});
