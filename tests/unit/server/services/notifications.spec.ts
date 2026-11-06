import { describe, expect, expectTypeOf, it } from 'vitest';
import { toBase64Url, utf8 } from '../../../../contracts/src/common';
import { hmacSha256Base64Url } from '../../../../src/server/services/crypto';
import {
	budgetOrder,
	digest,
	isEssential,
	listHeaders,
	shouldSend,
	UnsubscribeError,
	unsubscribeToken,
	verifyUnsubscribe,
	type DigestItem,
	type Queued
} from '../../../../src/server/services/notifications';
import {
	ESSENTIAL_CATEGORIES,
	NOTIFICATION_CATEGORIES,
	OPTIONAL_CATEGORIES,
	type NotificationCategory,
	type OptionalCategory
} from '../../../../src/shared/notifications';

const KEY = 'unsubscribe-test-key';
const NOW = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;

async function failure(promise: Promise<unknown>): Promise<UnsubscribeError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(UnsubscribeError);
		return error as UnsubscribeError;
	}
	throw new Error('expected an UnsubscribeError');
}

// signs a payload the way the issuer does, so a test can mint a token the issuer would not
async function signPayload(payload: object, key = KEY): Promise<string> {
	const encoded = toBase64Url(utf8(JSON.stringify(payload)));
	const signature = await hmacSha256Base64Url(key, `drupflare.unsubscribe.v1.${encoded}`);
	return `${encoded}.${signature}`;
}

describe('categories', () => {
	it('splits the union into essential and optional', () => {
		expect(ESSENTIAL_CATEGORIES).toEqual([
			'login-code',
			'invitation',
			'security-event',
			'payment-failure',
			'mandatory-notice'
		]);
		expect(OPTIONAL_CATEGORIES).toEqual(['ops', 'billing-info', 'reports', 'digest']);
		expect(NOTIFICATION_CATEGORIES).toHaveLength(9);
	});

	it('has no promotional, announcement or referral category', () => {
		const names: readonly string[] = NOTIFICATION_CATEGORIES;
		for (const banned of [
			'promotions',
			'promotional',
			'announcements',
			'referrals',
			'marketing'
		]) {
			expect(names).not.toContain(banned);
		}
	});

	it('rejects a fifth optional name at compile time', () => {
		expectTypeOf<OptionalCategory>().toEqualTypeOf<
			'ops' | 'billing-info' | 'reports' | 'digest'
		>();
		// @ts-expect-error promotions is not an optional category
		const name: OptionalCategory = 'promotions';
		expect(name).toBe('promotions');
	});

	it('classifies every name', () => {
		expect(isEssential('login-code')).toBe(true);
		expect(isEssential('ops')).toBe(false);
	});
});

describe('shouldSend', () => {
	const prefsSets = [
		{},
		{ ops: false },
		{ 'login-code': false },
		{ digest: false },
		{ ops: true }
	];

	it('sends essential mail whatever the preferences say', () => {
		for (const category of ESSENTIAL_CATEGORIES) {
			for (const prefs of prefsSets) {
				expect(shouldSend(category, prefs)).toBe(true);
			}
		}
	});

	it('sends optional mail only after an opt-in', () => {
		expect(shouldSend('ops', {})).toBe(false);
		expect(shouldSend('ops', { ops: false })).toBe(false);
		expect(shouldSend('ops', { ops: true })).toBe(true);
		expect(shouldSend('billing-info', { ops: true })).toBe(false);
	});
});

describe('budgetOrder', () => {
	const item = (id: string, category: NotificationCategory): Queued & { id: string } => ({
		id,
		category
	});
	const ids = (items: readonly { id: string }[]) => items.map((entry) => entry.id);

	it('never drops an essential message, even with no budget left', () => {
		const batch = [
			item('ops-1', 'ops'),
			item('login-1', 'login-code'),
			item('billing-1', 'billing-info'),
			item('digest-1', 'digest')
		];
		const result = budgetOrder(batch, 0);
		expect(ids(result.send)).toEqual(['login-1']);
		expect(ids(result.deferred)).toEqual(['ops-1', 'billing-1', 'digest-1']);
	});

	it('sends optional mail in the priority order ops, billing-info, reports, digest', () => {
		const batch = [
			item('digest-1', 'digest'),
			item('reports-1', 'reports'),
			item('billing-1', 'billing-info'),
			item('ops-1', 'ops')
		];
		const result = budgetOrder(batch, 3);
		expect(ids(result.send)).toEqual(['ops-1', 'billing-1', 'reports-1']);
		expect(ids(result.deferred)).toEqual(['digest-1']);
	});

	it('sends every essential message even when essentials alone exceed the budget', () => {
		const batch = [
			item('login-1', 'login-code'),
			item('invite-1', 'invitation'),
			item('security-1', 'security-event')
		];
		const result = budgetOrder(batch, 1);
		expect(ids(result.send)).toEqual(['login-1', 'invite-1', 'security-1']);
		expect(result.deferred).toEqual([]);
	});
});

describe('digest', () => {
	const at = (offset: number) => NOW + offset;
	const item = (id: string, category: NotificationCategory, offset: number): DigestItem =>
		({ id, category, at: at(offset), summary: id }) as DigestItem;

	it('groups optional items in one window, sorted by time, and leaves out essential mail', () => {
		const items = [
			item('ops-late', 'ops', 500),
			item('ops-early', 'ops', 100),
			item('billing-1', 'billing-info', 200),
			item('login-1', 'login-code', 300),
			item('ops-outside', 'ops', 10 * DAY)
		];
		const result = digest(items, { start: NOW, end: NOW + DAY });
		expect(result).not.toBeNull();
		expect(result!.groups.map((group) => group.category)).toEqual(['ops', 'billing-info']);
		expect(result!.groups[0]!.items.map((entry) => entry.id)).toEqual([
			'ops-early',
			'ops-late'
		]);
		const all = result!.groups.flatMap((group) => group.items.map((entry) => entry.id));
		expect(all).not.toContain('login-1');
		expect(all).not.toContain('ops-outside');
	});

	it('returns null when nothing falls in the window', () => {
		expect(
			digest([item('login-1', 'login-code', 0)], { start: NOW, end: NOW + DAY })
		).toBeNull();
	});
});

describe('unsubscribe tokens', () => {
	it('round-trips the user and the category', async () => {
		const token = await unsubscribeToken('usr_abc12345', 'ops', KEY, NOW);
		expect(await verifyUnsubscribe(token, KEY, NOW)).toEqual({
			userId: 'usr_abc12345',
			category: 'ops'
		});
	});

	it('refuses a token with a changed signature', async () => {
		const token = await unsubscribeToken('usr_abc12345', 'ops', KEY, NOW);
		const [payload, signature] = token.split('.') as [string, string];
		const swapped = signature[0] === 'a' ? `b${signature.slice(1)}` : `a${signature.slice(1)}`;
		const error = await failure(verifyUnsubscribe(`${payload}.${swapped}`, KEY, NOW));
		expect(error.code).toBe('bad_signature');
	});

	it('refuses a token whose payload was edited to name another category', async () => {
		const token = await unsubscribeToken('usr_abc12345', 'ops', KEY, NOW);
		const [, signature] = token.split('.') as [string, string];
		const edited = toBase64Url(
			utf8(JSON.stringify({ v: 1, u: 'usr_abc12345', c: 'digest', e: NOW + 365 * DAY }))
		);
		const error = await failure(verifyUnsubscribe(`${edited}.${signature}`, KEY, NOW));
		expect(error.code).toBe('bad_signature');
	});

	it('refuses a token signed with another key', async () => {
		const token = await unsubscribeToken('usr_abc12345', 'ops', 'other-key', NOW);
		const error = await failure(verifyUnsubscribe(token, KEY, NOW));
		expect(error.code).toBe('bad_signature');
	});

	it('refuses a correctly signed token that names an essential category', async () => {
		const token = await signPayload({ v: 1, u: 'usr_abc12345', c: 'login-code', e: NOW + DAY });
		const error = await failure(verifyUnsubscribe(token, KEY, NOW));
		expect(error.code).toBe('wrong_category');
	});

	it('refuses an expired token', async () => {
		const token = await unsubscribeToken('usr_abc12345', 'ops', KEY, NOW);
		const error = await failure(verifyUnsubscribe(token, KEY, NOW + 400 * DAY));
		expect(error.code).toBe('expired');
	});

	it('refuses text that is not a token', async () => {
		expect((await failure(verifyUnsubscribe('no-dot-here', KEY, NOW))).code).toBe('malformed');
		expect((await failure(verifyUnsubscribe('a.b.c', KEY, NOW))).code).toBe('malformed');
	});

	it('will not issue a token for an essential category', async () => {
		const error = await failure(
			Promise.resolve().then(() => unsubscribeToken('usr_abc12345', 'login-code', KEY, NOW))
		);
		expect(error.code).toBe('wrong_category');
	});
});

describe('listHeaders', () => {
	it('adds one-click list headers to optional mail', () => {
		expect(listHeaders('digest', 'https://example.test/u?token=t')).toEqual({
			'List-Unsubscribe': '<https://example.test/u?token=t>',
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
		});
	});

	it('adds no list headers to essential mail', () => {
		expect(listHeaders('login-code', 'https://example.test/u?token=t')).toEqual({});
	});
});
