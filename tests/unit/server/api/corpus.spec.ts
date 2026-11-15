import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import corpusList from '../../../../src/server/api/v1/orgs/[orgId]/corpus/index.get';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { ORG, OTHER_ORG } from '../../domain/fixtures';
import { asUser, send, setup } from '../fixtures/harness';

const ROUTE = '/api/v1/orgs/:orgId/corpus';
const BASE = `/api/v1/orgs/${ORG}/corpus`;

const committed = JSON.parse(
	readFileSync(
		fileURLToPath(new URL('../../../../src/shared/corpus.json', import.meta.url)),
		'utf8'
	)
) as { rows: string[]; repos: Record<string, unknown> };

afterEach(() => {
	resetApiDeps();
});

describe('GET corpus', () => {
	it('lists every codebase in the committed corpus with its row names', async () => {
		setup({ role: 'viewer' });
		const reply = await send(corpusList, ROUTE, { path: BASE, headers: asUser });
		expect(reply.status).toBe(200);
		const body = reply.json as { rows: string[]; items: { id: string; name: string }[] };
		expect(body.rows).toEqual(committed.rows);
		expect(body.items).toHaveLength(Object.keys(committed.repos).length);
	});

	it('filters by status and says why a refused codebase cannot be installed', async () => {
		setup({ role: 'viewer' });
		const reply = await send(corpusList, ROUTE, {
			path: `${BASE}?status=partial`,
			headers: asUser
		});
		const items = (reply.json as { items: { status: string; install: unknown }[] }).items;
		expect(items.length).toBeGreaterThan(0);
		for (const item of items) {
			expect(item.status).toBe('partial');
			expect(item.install).toMatchObject({ allowed: false });
		}
	});

	it('matches part of the name, title, summary or repository without regard to case', async () => {
		setup({ role: 'viewer' });
		const reply = await send(corpusList, ROUTE, { path: `${BASE}?q=DRUPAL`, headers: asUser });
		const body = reply.json as {
			items: { name: string; title: string; summary: string; repo: string | null }[];
		};
		expect(body.items.length).toBeGreaterThan(0);
		for (const item of body.items) {
			const haystack = [item.name, item.title, item.summary, item.repo ?? '']
				.join(' ')
				.toLowerCase();
			expect(haystack).toContain('drupal');
		}
	});

	it('refuses an unknown status with a validation error', async () => {
		setup({ role: 'viewer' });
		const reply = await send(corpusList, ROUTE, {
			path: `${BASE}?status=bogus`,
			headers: asUser
		});
		expect(reply.status).toBe(400);
	});

	it('refuses a request without a session', async () => {
		setup({ role: 'viewer' });
		const reply = await send(corpusList, ROUTE, { path: BASE });
		expect(reply.status).toBe(401);
	});

	it('does not answer for another organisation', async () => {
		setup({ role: 'viewer' });
		const reply = await send(corpusList, ROUTE, {
			path: `/api/v1/orgs/${OTHER_ORG}/corpus`,
			headers: asUser
		});
		expect(reply.status).toBe(403);
	});
});
