import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { draftDocRoutes } from '../../../scripts/docs-drafts';

let root: string;

const page = (rel: string, draft: boolean) => {
	const file = join(root, `${rel}.md`);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		`---\ntitle: ${rel}\ndescription: A page.\naudience: [developer]\ntype: written\ndraft: ${draft}\n---\n\n# ${rel}\n`
	);
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'docs-drafts-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('draftDocRoutes', () => {
	it('lists each draft page as its route, sorted, and skips published pages', () => {
		page('index', false);
		page('guides/billing/budgets', true);
		page('guides/billing/plans', false);
		page('start/faq', true);
		expect(draftDocRoutes(root)).toEqual(['/docs/guides/billing/budgets', '/docs/start/faq']);
	});

	it('maps a draft index page to the docs root', () => {
		page('index', true);
		expect(draftDocRoutes(root)).toEqual(['/docs']);
	});

	it('returns nothing when every page is published', () => {
		page('start/what-is-drupflare', false);
		expect(draftDocRoutes(root)).toEqual([]);
	});
});
