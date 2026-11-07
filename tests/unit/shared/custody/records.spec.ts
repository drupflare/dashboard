import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import {
	adminPasswordState,
	expiredPendingSecrets,
	OWNER_TOKEN_SQL,
	ownerTokenAad,
	ownerTokenIdOf,
	PENDING_SECRET_KINDS,
	PENDING_SECRET_SQL,
	pendingSecretAad,
	pendingSecretIdOf
} from '../../../../src/shared/custody/records';

describe('associated data', () => {
	it('binds an owner token to its site and a pending secret to its site and kind', () => {
		expect(ownerTokenAad('site_1')).toEqual({ siteId: 'site_1', purpose: 'owner-token' });
		expect(pendingSecretAad('site_1', 'admin-password')).toEqual({
			siteId: 'site_1',
			purpose: 'pending-secret:admin-password'
		});
		expect(pendingSecretAad('site_1', 'admin-password')).not.toEqual(ownerTokenAad('site_1'));
	});
});

describe('ids', () => {
	it('name one record per site and kind and carry no secret', () => {
		expect(ownerTokenIdOf('site_1')).toBe('owner-token:site_1');
		expect(pendingSecretIdOf('site_1', 'admin-password')).toBe(
			'pending-secret:site_1:admin-password'
		);
		expect(ownerTokenIdOf('site_1')).not.toBe(ownerTokenIdOf('site_2'));
	});
});

describe('expiredPendingSecrets', () => {
	const row = (siteId: string, expiresAt: number) => ({
		siteId,
		kind: 'admin-password' as const,
		expiresAt
	});

	it('lists the rows at or past their expiry and leaves the rest', () => {
		const rows = [row('a', 99), row('b', 100), row('c', 101)];
		expect(expiredPendingSecrets(rows, 100).map((r) => r.siteId)).toEqual(['a', 'b']);
		expect(expiredPendingSecrets(rows, 98)).toEqual([]);
		expect(expiredPendingSecrets([], 100)).toEqual([]);
	});

	it('keeps every field of a row it returns and does not change the input', () => {
		const rows = [{ ...row('a', 1), extra: 'kept' }];
		const [out] = expiredPendingSecrets(rows, 2);
		expect(out).toBe(rows[0]);
		expect(rows).toHaveLength(1);
	});
});

describe('adminPasswordState', () => {
	it('is available only for an unread row before its expiry', () => {
		expect(adminPasswordState({ expiresAt: 101, revealedAt: null }, 100, true)).toBe(
			'available'
		);
		expect(adminPasswordState({ expiresAt: 100, revealedAt: null }, 100, true)).toBe('expired');
		expect(adminPasswordState({ expiresAt: 99, revealedAt: null }, 100, false)).toBe('expired');
	});

	it('is revealed for a read row, even past its expiry', () => {
		expect(adminPasswordState({ expiresAt: 200, revealedAt: 50 }, 100, true)).toBe('revealed');
		expect(adminPasswordState({ expiresAt: 10, revealedAt: 5 }, 100, false)).toBe('revealed');
	});

	it('reads a missing row as expired when the admin was recorded and unknown when it was not', () => {
		expect(adminPasswordState(null, 100, true)).toBe('expired');
		expect(adminPasswordState(null, 100, false)).toBe('unknown');
	});
});

describe('the shared statements', () => {
	const db = new DatabaseSync(':memory:');
	for (const statement of SCHEMA_STATEMENTS) db.exec(statement);

	it('all prepare against the schema, so a renamed column fails here first', () => {
		for (const sql of [
			...Object.values(OWNER_TOKEN_SQL),
			...Object.values(PENDING_SECRET_SQL)
		]) {
			expect(() => db.prepare(sql)).not.toThrow();
		}
	});

	it('seal a pending secret again by replacing an unread one and clearing the read mark', () => {
		const seal = db.prepare(PENDING_SECRET_SQL.seal);
		seal.run('site_1', 'admin-password', 'first', 1, 10, 20);
		db.prepare(PENDING_SECRET_SQL.reveal).run(15, 'site_1', 'admin-password', 15);
		expect(db.prepare(PENDING_SECRET_SQL.select).get('site_1', 'admin-password')).toMatchObject(
			{ ciphertext: '', revealed_at: 15 }
		);
		seal.run('site_1', 'admin-password', 'second', 2, 30, 40);
		expect(db.prepare(PENDING_SECRET_SQL.select).get('site_1', 'admin-password')).toMatchObject(
			{ ciphertext: 'second', key_version: 2, expires_at: 40, revealed_at: null }
		);
	});

	it('reveal only an unread row that has not expired, and only once', () => {
		db.prepare(PENDING_SECRET_SQL.seal).run('site_2', 'admin-password', 'sealed', 1, 10, 20);
		const reveal = db.prepare(PENDING_SECRET_SQL.reveal);
		expect(reveal.run(20, 'site_2', 'admin-password', 20).changes).toBe(0);
		expect(reveal.run(19, 'site_2', 'admin-password', 19).changes).toBe(1);
		expect(reveal.run(19, 'site_2', 'admin-password', 19).changes).toBe(0);
	});

	it('refuse a kind the table does not know', () => {
		expect(() =>
			db.prepare(PENDING_SECRET_SQL.seal).run('site_3', 'database-password', 'x', 1, 1, 2)
		).toThrow(/CHECK/);
		expect(PENDING_SECRET_KINDS).toEqual(['admin-password']);
	});
});
