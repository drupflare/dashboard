import type { CollegeDBClient } from '@earth-app/collegedb';
import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from '../../../../contracts/src/common';
import type { Principal } from '../../../../src/server/domain/authorize';
import type { AuditInput } from '../../../../src/server/services/audit';
import {
	OwnerTokenConflictError,
	collegeOwnerTokenStore,
	principalActor,
	revealOwnerToken,
	rewrapOwnerToken,
	rotateOwnerToken,
	storeOwnerToken,
	withOwnerToken,
	type CustodyDeps,
	type SessionCall,
	type StoredOwnerToken
} from '../../../../src/server/services/owner-tokens';
import {
	CryptoError,
	decryptRecordText,
	loadKeyRing,
	type KeyRing
} from '../../../../src/shared/custody/envelope';
import { ApiError } from '../../../../src/shared/errors';
import { MemoryOwnerTokenStore } from './custody-support';

const kek = (fill: number) => toBase64Url(new Uint8Array(32).fill(fill));
const SECRET = 'worker-owner-token-0123456789';
const user: Principal = { kind: 'user', userId: 'user_1' };
const key: Principal = { kind: 'key', keyId: 'key_1', issuerId: 'user_1' };

async function setup(ring?: KeyRing) {
	const store = new MemoryOwnerTokenStore();
	const rows: AuditInput[] = [];
	const deps: CustodyDeps = {
		store,
		audit: {
			async append(input) {
				rows.push(input);
			}
		},
		ring: ring ?? (await loadKeyRing({ KEK_V1: kek(1) }))
	};
	return { store, rows, deps };
}

const session = (overrides: Partial<SessionCall> = {}): SessionCall => ({
	siteId: 'site_1',
	principal: user,
	stepUp: true,
	...overrides
});

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(ApiError);
		return error as ApiError;
	}
	throw new Error('expected an ApiError');
}

describe('storeOwnerToken', () => {
	it('stores an envelope, not the token, and writes one audit row', async () => {
		const { store, rows, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		const stored = store.rows.get('site_1');
		expect(stored?.previous).toBeNull();
		expect(JSON.stringify(stored)).not.toContain(SECRET);
		expect(rows).toEqual([
			{
				actor: 'system:create',
				action: 'site.owner-token.store',
				target: 'site_1',
				detail: { keyVersion: 1 }
			}
		]);
	});

	it('binds the stored record to its site', async () => {
		const { store, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		const moved = store.rows.get('site_1')!;
		store.rows.set('site_2', moved);
		await expect(revealOwnerToken(deps, session({ siteId: 'site_2' }))).rejects.toMatchObject({
			code: 'decrypt_failed'
		});
	});
});

describe('revealOwnerToken', () => {
	it('returns the token and writes one audit row naming the actor, site and key version', async () => {
		const { rows, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		rows.length = 0;
		expect(await revealOwnerToken(deps, session())).toBe(SECRET);
		expect(rows).toEqual([
			{
				actor: 'user:user_1',
				action: 'site.owner-token.reveal',
				target: 'site_1',
				detail: { keyVersion: 1 }
			}
		]);
	});

	it('refuses without step-up, before reading the store or auditing', async () => {
		const { store, rows, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		rows.length = 0;
		store.reads = 0;
		const error = await refusal(revealOwnerToken(deps, session({ stepUp: false })));
		expect(error.code).toBe('forbidden');
		expect(error.details).toEqual({ reason: 'step_up_required' });
		expect(rows).toEqual([]);
		expect(store.reads).toBe(0);
	});

	it('refuses an api key principal even with step-up set', async () => {
		const { store, rows, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		rows.length = 0;
		store.reads = 0;
		const error = await refusal(revealOwnerToken(deps, session({ principal: key })));
		expect(error.code).toBe('forbidden');
		expect(error.details).toEqual({ reason: 'session_only' });
		expect(rows).toEqual([]);
		expect(store.reads).toBe(0);
	});

	it('gives not_found when no token is stored', async () => {
		const { rows, deps } = await setup();
		expect((await refusal(revealOwnerToken(deps, session()))).code).toBe('not_found');
		expect(rows).toEqual([]);
	});

	it('writes the audit row before the secret is decrypted', async () => {
		const { store, rows, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		rows.length = 0;
		const stored = store.rows.get('site_1')!;
		const bytes = fromBase64Url(stored.current.ct);
		bytes[0] = bytes[0]! ^ 1;
		store.rows.set('site_1', {
			...stored,
			current: { ...stored.current, ct: toBase64Url(bytes) }
		});
		await expect(revealOwnerToken(deps, session())).rejects.toBeInstanceOf(CryptoError);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.action).toBe('site.owner-token.reveal');
	});

	it('stops when the audit write fails, so no secret is returned', async () => {
		const { deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		const failing: CustodyDeps = {
			...deps,
			audit: {
				async append() {
					throw new Error('audit down');
				}
			}
		};
		await expect(revealOwnerToken(failing, session())).rejects.toThrow('audit down');
	});
});

describe('withOwnerToken', () => {
	it('hands the token to the callback, returns its result and audits the use', async () => {
		const { rows, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		rows.length = 0;
		const seen: string[] = [];
		const result = await withOwnerToken(
			deps,
			{ siteId: 'site_1', actor: 'system:op_1', operation: 'config.apply' },
			async (token) => {
				seen.push(token);
				return 42;
			}
		);
		expect(result).toBe(42);
		expect(seen).toEqual([SECRET]);
		expect(rows).toEqual([
			{
				actor: 'system:op_1',
				action: 'site.owner-token.use',
				target: 'site_1',
				detail: { keyVersion: 1, operation: 'config.apply' }
			}
		]);
	});

	it('gives not_found without calling the callback', async () => {
		const { deps } = await setup();
		let called = false;
		const error = await refusal(
			withOwnerToken(deps, { siteId: 'site_9', actor: 'a', operation: 'o' }, async () => {
				called = true;
			})
		);
		expect(error.code).toBe('not_found');
		expect(called).toBe(false);
	});

	it('does not need a step-up or a session, since the platform acts on its own', async () => {
		const { deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		await expect(
			withOwnerToken(
				deps,
				{ siteId: 'site_1', actor: 'system:op', operation: 'x' },
				async (t) => t
			)
		).resolves.toBe(SECRET);
	});
});

describe('rotateOwnerToken', () => {
	it('replaces the token, pushes the new one with the old, and writes one audit row', async () => {
		const { store, rows, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		rows.length = 0;
		const pushed: [string, string][] = [];
		await rotateOwnerToken(deps, session(), async (next, old) => {
			pushed.push([next, old]);
		});
		const fresh = await revealOwnerToken(deps, session());
		expect(pushed).toEqual([[fresh, SECRET]]);
		expect(fresh).not.toBe(SECRET);
		expect(store.rows.get('site_1')?.previous).toBeNull();
		const rotateRows = rows.filter((r) => r.action === 'site.owner-token.rotate');
		expect(rotateRows).toEqual([
			{
				actor: 'user:user_1',
				action: 'site.owner-token.rotate',
				target: 'site_1',
				detail: { fromKeyVersion: 1, keyVersion: 1 }
			}
		]);
		expect(rows.some((r) => r.action === 'site.owner-token.rotate-failed')).toBe(false);
	});

	it('keeps the old record in previous while push runs', async () => {
		const { store, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		const before = store.rows.get('site_1')!;
		let during: StoredOwnerToken | undefined;
		await rotateOwnerToken(deps, session(), async () => {
			during = store.rows.get('site_1');
		});
		expect(during?.previous).toEqual(before.current);
		expect(during?.current).not.toEqual(before.current);
	});

	it('restores the old token and records the failure when push throws', async () => {
		const { store, rows, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		const before = structuredClone(store.rows.get('site_1'))!;
		rows.length = 0;
		await expect(
			rotateOwnerToken(deps, session(), async () => {
				throw new Error('worker unreachable');
			})
		).rejects.toThrow('worker unreachable');
		const after = store.rows.get('site_1')!;
		expect(after.current).toEqual(before.current);
		expect(after.previous).toBeNull();
		expect(after.version).toBeGreaterThan(before.version);
		expect(rows.map((r) => r.action)).toEqual([
			'site.owner-token.rotate',
			'site.owner-token.rotate-failed'
		]);
		expect(await revealOwnerToken(deps, session())).toBe(SECRET);
	});

	it('refuses without step-up and for an api key, touching nothing', async () => {
		const { store, rows, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		rows.length = 0;
		const before = structuredClone(store.rows.get('site_1'));
		const push = async () => {
			throw new Error('push must not run');
		};
		expect(
			(await refusal(rotateOwnerToken(deps, session({ stepUp: false }), push))).details
		).toEqual({
			reason: 'step_up_required'
		});
		expect(
			(await refusal(rotateOwnerToken(deps, session({ principal: key }), push))).details
		).toEqual({
			reason: 'session_only'
		});
		expect(rows).toEqual([]);
		expect(store.rows.get('site_1')).toEqual(before);
	});

	it('gives not_found when no token is stored', async () => {
		const { deps } = await setup();
		expect((await refusal(rotateOwnerToken(deps, session(), async () => {}))).code).toBe(
			'not_found'
		);
	});

	it('writes the new record under the newest key version', async () => {
		const { store, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		const grown: CustodyDeps = {
			...deps,
			ring: await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) })
		};
		await rotateOwnerToken(grown, session(), async () => {});
		expect(store.rows.get('site_1')?.current.kv).toBe(2);
	});
});

describe('rewrapOwnerToken', () => {
	it('moves the record to the newest key version and keeps the token', async () => {
		const { store, rows, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		const before = store.rows.get('site_1')!;
		const grown: CustodyDeps = {
			...deps,
			ring: await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) })
		};
		rows.length = 0;
		expect(await rewrapOwnerToken(grown, { siteId: 'site_1', actor: 'system:rewrap' })).toBe(
			true
		);
		const after = store.rows.get('site_1')!;
		expect(after.current.kv).toBe(2);
		expect(after.current.ct).toBe(before.current.ct);
		expect(rows).toEqual([
			{
				actor: 'system:rewrap',
				action: 'site.owner-token.rewrap',
				target: 'site_1',
				detail: { fromKeyVersion: 1, keyVersion: 2 }
			}
		]);
		const retired: CustodyDeps = { ...deps, ring: await loadKeyRing({ KEK_V2: kek(2) }) };
		expect(await revealOwnerToken(retired, session())).toBe(SECRET);
	});

	it('does nothing and writes no audit row when the record is current', async () => {
		const { rows, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		rows.length = 0;
		expect(await rewrapOwnerToken(deps, { siteId: 'site_1', actor: 'system:rewrap' })).toBe(
			false
		);
		expect(rows).toEqual([]);
	});

	it('moves a leftover previous record too', async () => {
		const { store, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		const ring2 = await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) });
		const grown: CustodyDeps = { ...deps, ring: ring2 };
		const stored = store.rows.get('site_1')!;
		await rewrapOwnerToken(grown, { siteId: 'site_1', actor: 'a' });
		const current = store.rows.get('site_1')!.current;
		store.rows.set('site_1', { version: 9, current, previous: stored.current });
		expect(await rewrapOwnerToken(grown, { siteId: 'site_1', actor: 'a' })).toBe(true);
		const after = store.rows.get('site_1')!;
		expect(after.previous?.kv).toBe(2);
		expect(
			await decryptRecordText(
				after.previous,
				{ siteId: 'site_1', purpose: 'owner-token' },
				ring2
			)
		).toBe(SECRET);
	});

	it('gives not_found when no token is stored', async () => {
		const { deps } = await setup();
		expect((await refusal(rewrapOwnerToken(deps, { siteId: 'x', actor: 'a' }))).code).toBe(
			'not_found'
		);
	});
});

describe('audit rows never carry a secret', () => {
	it('holds across store, use, reveal, rotate, a failed rotate and rewrap', async () => {
		const { rows, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		await withOwnerToken(
			deps,
			{ siteId: 'site_1', actor: 's', operation: 'o' },
			async () => {}
		);
		await revealOwnerToken(deps, session());
		let pushedNew = '';
		await rotateOwnerToken(deps, session(), async (next) => {
			pushedNew = next;
		});
		const revealed = await revealOwnerToken(deps, session());
		await rotateOwnerToken(deps, session(), async () => {
			throw new Error('nope');
		}).catch(() => {});
		const grown: CustodyDeps = {
			...deps,
			ring: await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) })
		};
		await rewrapOwnerToken(grown, { siteId: 'site_1', actor: 's' });
		expect(rows.length).toBeGreaterThanOrEqual(8);
		const serialized = JSON.stringify(rows);
		for (const secret of [SECRET, pushedNew, revealed]) {
			expect(secret.length).toBeGreaterThan(20);
			expect(serialized).not.toContain(secret);
		}
	});
});

describe('principalActor', () => {
	it('names a user and a key', () => {
		expect(principalActor(user)).toBe('user:user_1');
		expect(principalActor(key)).toBe('key:key_1');
	});
});

describe('concurrent writers', () => {
	it('gives the loser of two rotations a typed conflict, and the winner keeps custody', async () => {
		const store = new MemoryOwnerTokenStore(true);
		const rows: AuditInput[] = [];
		const deps: CustodyDeps = {
			store,
			audit: { append: async (input) => void rows.push(input) },
			ring: await loadKeyRing({ KEK_V1: kek(1) })
		};
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		const pushed: string[] = [];
		const push = async (next: string) => void pushed.push(next);
		const results = await Promise.allSettled([
			rotateOwnerToken(deps, session(), push),
			rotateOwnerToken(deps, session(), push)
		]);
		const lost = results.filter((r) => r.status === 'rejected');
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(lost).toHaveLength(1);
		const error = (lost[0] as PromiseRejectedResult).reason;
		expect(error).toBeInstanceOf(OwnerTokenConflictError);
		expect(error).toMatchObject({
			code: 'conflict',
			status: 409,
			details: { reason: 'owner_token_conflict', siteId: 'site_1' }
		});
		expect(pushed).toHaveLength(1);
		expect(await revealOwnerToken(deps, session())).toBe(pushed[0]);
		const failed = rows.filter((row) => row.action === 'site.owner-token.rotate-failed');
		expect(failed).toEqual([
			{
				actor: 'user:user_1',
				action: 'site.owner-token.rotate-failed',
				target: 'site_1',
				detail: { keyVersion: 1, reason: 'conflict' }
			}
		]);
	});

	it('leaves a record that another writer moved during a failed push alone', async () => {
		const { store, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		let moved: StoredOwnerToken | undefined;
		await expect(
			rotateOwnerToken(deps, session(), async () => {
				const stored = store.rows.get('site_1')!;
				await store.put(
					'site_1',
					{ current: stored.current, previous: null },
					stored.version
				);
				moved = store.rows.get('site_1');
				throw new Error('worker unreachable');
			})
		).rejects.toThrow('worker unreachable');
		expect(store.rows.get('site_1')).toEqual(moved);
	});

	it('surfaces a conflict when the record moved before the final write', async () => {
		const { store, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		await expect(
			rotateOwnerToken(deps, session(), async () => {
				const stored = store.rows.get('site_1')!;
				await store.put('site_1', stored, stored.version);
			})
		).rejects.toBeInstanceOf(OwnerTokenConflictError);
	});

	it('refuses a rewrap that lost a race instead of overwriting the winner', async () => {
		const { store, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'system:create', token: SECRET });
		const grown: CustodyDeps = {
			...deps,
			store: {
				get: async (siteId) => {
					const stale = await store.get(siteId);
					const stored = store.rows.get(siteId)!;
					await store.put(siteId, stored, stored.version);
					return stale;
				},
				put: (siteId, value, expected) => store.put(siteId, value, expected)
			},
			ring: await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) })
		};
		await expect(
			rewrapOwnerToken(grown, { siteId: 'site_1', actor: 'system:rewrap' })
		).rejects.toBeInstanceOf(OwnerTokenConflictError);
		expect(store.rows.get('site_1')?.current.kv).toBe(1);
	});

	it('stores over an existing record by naming its version', async () => {
		const { store, deps } = await setup();
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'a', token: SECRET });
		await storeOwnerToken(deps, { siteId: 'site_1', actor: 'a', token: `${SECRET}-2` });
		expect(store.rows.get('site_1')?.version).toBe(2);
		expect(await revealOwnerToken(deps, session())).toBe(`${SECRET}-2`);
	});
});

describe('collegeOwnerTokenStore', () => {
	const envelope = {
		v: 1,
		kv: 1,
		wk: 'w'.repeat(80),
		iv: 'i'.repeat(16),
		ct: 'c'.repeat(22)
	};

	function fakeDb(answers: unknown[]) {
		const calls: { key: string; sql: string; params: unknown[] }[] = [];
		const db = {
			async first(key: string, sql: string, params: unknown[]) {
				calls.push({ key, sql, params });
				return answers.shift() ?? null;
			}
		} as unknown as CollegeDBClient;
		return { calls, store: collegeOwnerTokenStore(async () => db) };
	}

	it('inserts the first record and updates later ones by version', async () => {
		const { calls, store } = fakeDb([{ version: 1 }, { version: 2 }]);
		const record = { current: envelope as never, previous: null };
		expect(await store.put('site_1', record, null)).toBe(1);
		expect(await store.put('site_1', record, 1)).toBe(2);
		expect(calls[0]!.sql).toMatch(/INSERT INTO owner_tokens .* ON CONFLICT .* DO NOTHING/s);
		expect(calls[1]!.sql).toMatch(/UPDATE owner_tokens SET version = version \+ 1/);
		expect(calls[1]!.params.slice(-2)).toEqual(['site_1', 1]);
		expect(calls.map((call) => call.key)).toEqual(['site_1', 'site_1']);
	});

	it('throws the typed conflict when no row came back', async () => {
		const { store } = fakeDb([null, null]);
		const record = { current: envelope as never, previous: null };
		await expect(store.put('site_1', record, null)).rejects.toBeInstanceOf(
			OwnerTokenConflictError
		);
		await expect(store.put('site_1', record, 3)).rejects.toBeInstanceOf(
			OwnerTokenConflictError
		);
	});

	it('reads a stored row back into envelopes, and null for a missing one', async () => {
		const row = {
			version: 4,
			current_envelope: JSON.stringify(envelope),
			previous_envelope: JSON.stringify({ ...envelope, kv: 2 })
		};
		const { store } = fakeDb([row, null]);
		expect(await store.get('site_1')).toEqual({
			version: 4,
			current: envelope,
			previous: { ...envelope, kv: 2 }
		});
		expect(await store.get('site_2')).toBeNull();
	});

	it('reads a row with no previous envelope as null', async () => {
		const { store } = fakeDb([
			{ version: 1, current_envelope: JSON.stringify(envelope), previous_envelope: null }
		]);
		expect((await store.get('site_1'))?.previous).toBeNull();
	});
});
