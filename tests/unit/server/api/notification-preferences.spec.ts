import type { CollegeDBClient } from '@earth-app/collegedb';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import preferencesGet from '../../../../src/server/api/v1/me/notifications.get';
import preferencesPut from '../../../../src/server/api/v1/me/notifications.put';
import unsubscribeGet from '../../../../src/server/api/v1/unsubscribe.get';
import unsubscribePost from '../../../../src/server/api/v1/unsubscribe.post';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import {
	setPreferenceServices,
	unsubscribeUrlFor
} from '../../../../src/server/services/notification-preferences';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { asKey, asUser, send, setup } from '../fixtures/harness';

const NOW = 1_800_000_000_000;

function world() {
	const sql = new DatabaseSync(':memory:');
	for (const statement of SCHEMA_STATEMENTS) sql.exec(statement);
	const db = {
		async first(_key: string, text: string, bindings: unknown[] = []) {
			return sql.prepare(text).get(...(bindings as never[])) ?? null;
		},
		async all(_key: string, text: string, bindings: unknown[] = []) {
			return { results: sql.prepare(text).all(...(bindings as never[])) };
		},
		async run(_key: string, text: string, bindings: unknown[] = []) {
			const result = sql.prepare(text).run(...(bindings as never[]));
			return { meta: { changes: Number(result.changes) } };
		}
	} as unknown as CollegeDBClient;
	const audits: { orgId: string; action: string; target: string }[] = [];
	const deps = {
		getDb: async () => db,
		audit: async (orgId: string, input: { action: string; target: string }) => {
			audits.push({ orgId, action: input.action, target: input.target });
		},
		now: () => NOW,
		keySecret: 'a-sign-in-code-secret-for-tests-only',
		baseUrl: 'https://app.example.test'
	};
	setPreferenceServices(deps);
	return { sql, audits, deps };
}

const readPreferences = (headers: Record<string, string> = asUser) =>
	send(preferencesGet, '/api/v1/me/notifications', {
		path: '/api/v1/me/notifications',
		headers
	});

const putPreferences = (json: unknown, headers: Record<string, string> = asUser) =>
	send(preferencesPut, '/api/v1/me/notifications', {
		method: 'PUT',
		path: '/api/v1/me/notifications',
		headers,
		json
	});

const stored = (sql: DatabaseSync) =>
	sql.prepare('SELECT user_id, category, enabled FROM notification_preferences').all();

let current: ReturnType<typeof world>;

beforeEach(() => {
	resetApiDeps();
	setup();
	current = world();
});

afterEach(() => {
	setPreferenceServices(null);
	resetApiDeps();
});

describe('reading and changing preferences', () => {
	it('lists the optional switches on, the daily summary off, and the mail that always sends', async () => {
		const reply = await readPreferences();
		expect(reply.status).toBe(200);
		const body = reply.json as {
			switches: { category: string; enabled: boolean }[];
			essential: { label: string }[];
		};
		expect(body.switches.map((item) => item.enabled)).toEqual([true, true, true, false]);
		expect(body.essential.length).toBeGreaterThan(0);
	});

	it('switches a category off for the signed-in account', async () => {
		const reply = await putPreferences({ preferences: { ops: false } });
		expect(reply.status).toBe(200);
		expect(stored(current.sql)).toEqual([{ user_id: 'user-1', category: 'ops', enabled: 0 }]);
		expect(current.audits).toEqual([
			{ orgId: 'org_user1', action: 'account.notifications.update', target: 'ops' }
		]);
	});

	it('ignores a user id in the body and changes only the signed-in account', async () => {
		const reply = await putPreferences({
			userId: 'user-2',
			user_id: 'user-2',
			preferences: { ops: false }
		});
		expect(reply.status).toBe(200);
		expect(stored(current.sql)).toEqual([{ user_id: 'user-1', category: 'ops', enabled: 0 }]);
	});

	it('refuses an essential category and stores nothing', async () => {
		const reply = await putPreferences({ preferences: { 'budget-limit': false } });
		expect(reply.status).toBe(400);
		expect(stored(current.sql)).toEqual([]);
	});

	it('refuses an empty change', async () => {
		expect((await putPreferences({ preferences: {} })).status).toBe(400);
	});

	it('refuses an API key on the change and does not store anything', async () => {
		const reply = await putPreferences({ preferences: { ops: true } }, asKey);
		expect(reply.status).toBeGreaterThanOrEqual(400);
		expect(reply.status).toBeLessThan(500);
		expect(stored(current.sql)).toEqual([]);
	});

	it('needs a session to read', async () => {
		expect((await readPreferences({})).status).toBe(401);
	});
});

describe('the unsubscribe routes', () => {
	const linkFor = async (category = 'ops' as const) =>
		new URL(await unsubscribeUrlFor(current.deps, { userId: 'user-1' }, category));

	it('posts the one-click form to the link in the mail header and ignores the body', async () => {
		const link = await linkFor();
		const reply = await send(unsubscribePost, '/api/v1/unsubscribe', {
			method: 'POST',
			path: `${link.pathname}${link.search}`,
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			raw: 'List-Unsubscribe=One-Click'
		});
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({ unsubscribed: true, category: 'ops' });
		expect(stored(current.sql)).toEqual([{ user_id: 'user-1', category: 'ops', enabled: 0 }]);
	});

	it('answers a replay the same way', async () => {
		const link = await linkFor();
		const post = () =>
			send(unsubscribePost, '/api/v1/unsubscribe', {
				method: 'POST',
				path: `${link.pathname}${link.search}`,
				json: {}
			});
		expect((await post()).status).toBe(200);
		expect((await post()).status).toBe(200);
	});

	it('refuses a token that was edited', async () => {
		const link = await linkFor();
		const token = link.searchParams.get('token') ?? '';
		const reply = await send(unsubscribePost, '/api/v1/unsubscribe', {
			method: 'POST',
			path: `/api/v1/unsubscribe?token=${encodeURIComponent(`${token}x`)}`,
			json: {}
		});
		expect(reply.status).toBe(400);
	});

	it('refuses a missing token', async () => {
		const reply = await send(unsubscribePost, '/api/v1/unsubscribe', {
			method: 'POST',
			path: '/api/v1/unsubscribe',
			json: {}
		});
		expect(reply.status).toBe(400);
	});

	it('redirects a browser to the page and changes nothing on a read', async () => {
		const link = await linkFor();
		const reply = await send(unsubscribeGet, '/api/v1/unsubscribe', {
			path: `${link.pathname}${link.search}`
		});
		expect(reply.status).toBe(302);
		expect(reply.headers.get('location')).toBe(
			`/unsubscribe/${encodeURIComponent(link.searchParams.get('token') ?? '')}`
		);
		expect(stored(current.sql)).toEqual([]);
	});
});
