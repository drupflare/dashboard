import type { CollegeDBClient } from '@earth-app/collegedb';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import { renderMail, type MailInput } from '../../../../src/server/emails';
import {
	budgetAlertSink,
	collegeRecipients,
	type AlertRecipient
} from '../../../../src/server/services/budget-alerts';
import type { AlertNotice } from '../../../../src/server/services/budget-enforcement';
import {
	deriveUnsubscribeKey,
	getPreferencesView,
	setPreferences,
	unsubscribe,
	unsubscribeUrlFor,
	type PreferenceServices
} from '../../../../src/server/services/notification-preferences';
import { shouldSend, unsubscribeToken } from '../../../../src/server/services/notifications';
import { collegeReviewers, reviewMailer } from '../../../../src/server/services/review-mail';
import { ApiError } from '../../../../src/shared/errors';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const SECRET = 'a-sign-in-code-secret-for-tests-only';
const BASE = 'https://app.example.test';
const ORG = 'org_acme';

function world(secret: string | undefined = SECRET) {
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
	const clock = { now: NOW };
	const audits: { orgId: string; action: string; target: string; detail: unknown }[] = [];
	const deps: PreferenceServices = {
		getDb: async () => db,
		audit: async (orgId, input) => {
			audits.push({
				orgId,
				action: input.action,
				target: input.target,
				detail: input.detail
			});
		},
		now: () => clock.now,
		keySecret: secret,
		baseUrl: BASE
	};
	sql.prepare(
		'INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, 1)'
	).run(ORG, 'Acme', 'seed');
	const addUser = (id: string, role: 'owner' | 'admin' | 'billing' | 'viewer') => {
		sql.prepare(
			'INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, 1, 1)'
		).run(id, `${id}@example.test`);
		sql.prepare(
			'INSERT INTO members (id, organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)'
		).run(`m-${id}`, ORG, id, role);
	};
	const notifyOn = (role: string) =>
		(
			sql
				.prepare(
					'SELECT notify_on FROM org_contacts WHERE organization_id = ? AND role = ?'
				)
				.get(ORG, role) as { notify_on: number }
		).notify_on;
	const addContact = (role: string, on: boolean) =>
		sql
			.prepare(
				`INSERT INTO org_contacts (id, organization_id, role, name, email, verified_at, notify_on, created_at, updated_at)
				 VALUES (?, ?, ?, 'Pat', 'pat@example.org', 1, ?, 1, 1)`
			)
			.run(`ct-${role}`, ORG, role, on ? 1 : 0);
	const rows = () =>
		sql.prepare('SELECT user_id, category, enabled FROM notification_preferences').all();
	return { sql, db, deps, clock, audits, addUser, addContact, notifyOn, rows };
}

async function refused(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(ApiError);
		return error as ApiError;
	}
	throw new Error('expected a refusal');
}

const tokenOf = (url: string) => new URL(url).searchParams.get('token') ?? '';

describe('preferences', () => {
	it('shows the optional switches on until they are turned off, the digest off, and lists the mail that always sends', async () => {
		const w = world();
		const view = await getPreferencesView(w.deps, 'u1');
		expect(view.switches.map((item) => [item.category, item.enabled])).toEqual([
			['ops', true],
			['billing-info', true],
			['reports', true],
			['digest', false]
		]);
		expect(view.essential.map((item) => item.label)).toContain(
			'Stop Alerts: When a Site Reaches Its Budget'
		);
		expect(view.switches.find((item) => item.category === 'digest')?.available).toBe(false);
	});

	it('stores a choice, audits each change once, and skips an unchanged value', async () => {
		const w = world();
		await setPreferences(w.deps, 'u1', { ops: true });
		expect(w.audits).toEqual([]);
		await setPreferences(w.deps, 'u1', { ops: false });
		await setPreferences(w.deps, 'u1', { ops: false });
		expect(w.audits).toEqual([
			{
				orgId: 'org_u1',
				action: 'account.notifications.update',
				target: 'ops',
				detail: { enabled: false, via: 'settings' }
			}
		]);
		const view = await setPreferences(w.deps, 'u1', { ops: true, 'billing-info': false });
		expect(view.switches.filter((item) => item.enabled).map((item) => item.category)).toEqual([
			'ops',
			'reports'
		]);
		expect(w.audits).toHaveLength(3);
	});

	it('keeps one account apart from another', async () => {
		const w = world();
		await setPreferences(w.deps, 'u1', { ops: false });
		const other = await getPreferencesView(w.deps, 'u2');
		expect(other.switches.filter((item) => item.enabled).map((item) => item.category)).toEqual([
			'ops',
			'billing-info',
			'reports'
		]);
	});

	it('refuses an essential category, the unavailable digest and an unknown name, storing nothing', async () => {
		const w = world();
		for (const name of ['budget-limit', 'login-code', 'security-event']) {
			const error = await refused(setPreferences(w.deps, 'u1', { [name]: false }));
			expect(error.code).toBe('validation');
			expect(error.message).toContain('always sends');
		}
		expect((await refused(setPreferences(w.deps, 'u1', { digest: true }))).message).toContain(
			'not available yet'
		);
		await refused(setPreferences(w.deps, 'u1', { promotions: true }));
		// a refused request changes nothing, even beside a valid name
		await refused(setPreferences(w.deps, 'u1', { ops: true, 'budget-limit': false }));
		expect(w.rows()).toEqual([]);
		expect(w.audits).toEqual([]);
	});
});

describe('the unsubscribe key', () => {
	it('is derived from the secret with HKDF and is neither the secret nor the same for another secret', async () => {
		const key = await deriveUnsubscribeKey(SECRET);
		expect(key).not.toBe(SECRET);
		expect(key).toBe(await deriveUnsubscribeKey(SECRET));
		expect(key).not.toBe(await deriveUnsubscribeKey(`${SECRET}-2`));
		expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('makes no link and refuses a token while no secret exists', async () => {
		const w = world('');
		expect((await refused(unsubscribeUrlFor(w.deps, { userId: 'u1' }, 'ops'))).code).toBe(
			'not_built'
		);
		expect((await refused(unsubscribe(w.deps, 'x'.repeat(30)))).code).toBe('not_built');
	});
});

describe('unsubscribe', () => {
	it('switches off only the category in the link', async () => {
		const w = world();
		const url = await unsubscribeUrlFor(w.deps, { userId: 'u1' }, 'ops');
		expect(url.startsWith(`${BASE}/api/v1/unsubscribe?token=`)).toBe(true);
		expect(await unsubscribe(w.deps, tokenOf(url))).toEqual({
			unsubscribed: true,
			category: 'ops'
		});
		const view = await getPreferencesView(w.deps, 'u1');
		expect(view.switches.filter((item) => item.enabled).map((item) => item.category)).toEqual([
			'billing-info',
			'reports'
		]);
		expect(w.audits.at(-1)).toMatchObject({
			target: 'ops',
			detail: { enabled: false, via: 'unsubscribe' }
		});
	});

	it('is harmless to replay: it answers the same and writes no second audit row', async () => {
		const w = world();
		await setPreferences(w.deps, 'u1', { ops: true });
		const token = tokenOf(await unsubscribeUrlFor(w.deps, { userId: 'u1' }, 'ops'));
		await unsubscribe(w.deps, token);
		const audits = w.audits.length;
		expect(await unsubscribe(w.deps, token)).toEqual({ unsubscribed: true, category: 'ops' });
		expect(w.audits).toHaveLength(audits);
	});

	it('refuses an edited token, a token signed with another key and an expired token', async () => {
		const w = world();
		const token = tokenOf(await unsubscribeUrlFor(w.deps, { userId: 'u1' }, 'ops'));
		const [payload, signature] = token.split('.') as [string, string];
		const other = Buffer.from(
			JSON.stringify({
				...JSON.parse(Buffer.from(payload, 'base64url').toString()),
				u: 'u:u2'
			})
		).toString('base64url');
		expect((await refused(unsubscribe(w.deps, `${other}.${signature}`))).code).toBe(
			'validation'
		);
		const foreign = tokenOf(
			await unsubscribeUrlFor(
				{ ...w.deps, keySecret: `${SECRET}-other` },
				{ userId: 'u1' },
				'ops'
			)
		);
		expect((await refused(unsubscribe(w.deps, foreign))).code).toBe('validation');
		w.clock.now += 366 * DAY;
		expect((await refused(unsubscribe(w.deps, token))).message).toContain('no longer valid');
		expect(w.rows()).toEqual([]);
	});

	it('refuses a signed token that names an essential category or a subject it cannot read', async () => {
		const w = world();
		const key = await deriveUnsubscribeKey(SECRET);
		// the signer itself refuses an essential category
		await expect(unsubscribeToken('u:u1', 'budget-limit', key, NOW)).rejects.toMatchObject({
			code: 'wrong_category'
		});
		const nameless = await unsubscribeToken('someone', 'ops', key, NOW);
		expect((await refused(unsubscribe(w.deps, nameless))).code).toBe('validation');
	});

	it('turns off a contact through its own notify switch', async () => {
		const w = world();
		w.addContact('billing', true);
		const url = await unsubscribeUrlFor(
			w.deps,
			{ userId: null, contact: { orgId: ORG, role: 'billing' } },
			'billing-info'
		);
		await unsubscribe(w.deps, tokenOf(url));
		expect(w.notifyOn('billing')).toBe(0);
		expect(w.audits).toEqual([]);
	});
});

describe('senders honour the stored choice', () => {
	it('mails a reviewer by default, skips one who switched it off, with a working unsubscribe link', async () => {
		const w = world();
		w.addUser('u1', 'owner');
		w.addUser('u2', 'admin');
		await setPreferences(w.deps, 'u2', { ops: false });
		const sent: { to: string; url: string }[] = [];
		const recorded: string[] = [];
		const mailer = reviewMailer({
			recipients: async (orgId) => collegeReviewers(w.db, orgId),
			paused: async () => false,
			record: async (category, status) => {
				recorded.push(`${category}:${status}`);
			},
			unsubscribeUrl: (reviewer, category) => unsubscribeUrlFor(w.deps, reviewer, category),
			send: async (to, input: MailInput) => {
				const rendered = renderMail(input);
				sent.push({ to, url: rendered.headers['List-Unsubscribe'] ?? '' });
			},
			baseUrl: BASE
		});
		const result = await mailer(ORG, {
			orgName: 'Acme',
			scopeName: 'Members',
			dueAt: '2026-12-01T00:00:00.000Z',
			reviewUrl: '/org/reviews/1'
		} as never);
		expect(result).toEqual({ sent: 1, skipped: 1 });
		expect(sent.map((item) => item.to)).toEqual(['u1@example.test']);
		expect(recorded).toContain('ops:skipped-preference');
		const link = sent[0]?.url.slice(1, -1) ?? '';
		await unsubscribe(w.deps, tokenOf(link));
		expect((await getPreferencesView(w.deps, 'u1')).switches[0]?.enabled).toBe(false);
	});

	it('gives the budget alert sink the stored choice, essential mail to everyone and a held alert once the key exists', async () => {
		const w = world();
		w.addUser('u1', 'owner');
		w.addUser('u2', 'billing');
		await setPreferences(w.deps, 'u2', { 'billing-info': false });
		const claims = new Set<string>();
		const sent: { to: string; category: string; unsubscribe: boolean }[] = [];
		const logs: string[] = [];
		const sink = (secret: boolean) =>
			budgetAlertSink({
				now: () => NOW,
				log: (message) => logs.push(message),
				paused: async () => false,
				remaining: async () => 100,
				recordSent: async () => undefined,
				sent: async () => [],
				claim: async (_org, scopeKey, period, key) => {
					const id = `${scopeKey}|${period}|${key}`;
					if (claims.has(id)) return false;
					claims.add(id);
					return true;
				},
				release: async () => undefined,
				recipients: async (orgId) => collegeRecipients(w.db, orgId),
				names: async () => ({ orgName: 'Acme', siteName: null }),
				...(secret
					? {
							unsubscribeUrl: (recipient: AlertRecipient, category: never) =>
								unsubscribeUrlFor(w.deps, recipient, category)
						}
					: {}),
				budgetUrl: () => `${BASE}/billing`,
				send: async (to, input) => {
					const rendered = renderMail(input);
					sent.push({
						to,
						category: rendered.category,
						unsubscribe: 'List-Unsubscribe' in rendered.headers
					});
				}
			});
		const notice = (alerts: AlertNotice['alerts']): AlertNotice => ({
			orgId: ORG,
			siteId: null,
			period: '2026-11',
			alerts,
			budget: { percent: 500, enforcement: 'block' },
			allowanceViews: 1000,
			views: 760,
			mode: 'on'
		});

		await sink(false).notify(notice(['allowance-75']));
		expect(sent).toEqual([]);
		expect(logs).toContain('held: no unsubscribe secret');

		await sink(true).notify(notice(['allowance-75']));
		expect(sent).toEqual([
			{ to: 'u1@example.test', category: 'billing-info', unsubscribe: true }
		]);

		// once per period: a later evaluation does not mail it again
		await sink(true).notify(notice(['allowance-75']));
		expect(sent).toHaveLength(1);

		// essential mail goes to both owners and billing members whatever they chose
		await sink(true).notify(notice(['budget-90']));
		expect(sent.slice(1).map((item) => item.to)).toEqual([
			'u1@example.test',
			'u2@example.test'
		]);
		expect(sent.slice(1).every((item) => !item.unsubscribe)).toBe(true);
	});

	it('lets a contact keep its own notify switch and never overrides essential mail', async () => {
		const w = world();
		w.addContact('billing', true);
		const recipients = await collegeRecipients(w.db, ORG);
		expect(recipients[0]).toMatchObject({
			userId: null,
			contact: { orgId: ORG, role: 'billing' },
			prefs: { 'billing-info': true }
		});
		expect(shouldSend('billing-info', recipients[0]?.prefs ?? {}, false)).toBe(true);
		// the platform pause stops optional mail and leaves essential mail alone
		expect(shouldSend('billing-info', recipients[0]?.prefs ?? {}, true)).toBe(false);
		expect(shouldSend('budget-limit', {}, true)).toBe(true);
	});
});
