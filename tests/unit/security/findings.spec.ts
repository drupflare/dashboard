import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	generateSigningKey,
	newId,
	siteId as siteIdSchema,
	toBase64Url
} from '../../../contracts/src/common';
import { commandBodySchema } from '../../../contracts/src/fleet-link';
import { checkLease, issueLease, type AuthorityState } from '../../../contracts/src/site-auth';
import { authorize } from '../../../src/server/domain/authorize';
import { acceptDelegation, createDelegation } from '../../../src/server/domain/delegation';
import { append, verify } from '../../../src/server/services/audit';
import { loadKeyRing } from '../../../src/server/services/crypto';
import {
	CODE_MAX_ATTEMPTS,
	CODE_RESEND_COOLDOWN_MS,
	CODE_SEND_RATE,
	consumeCode,
	issueCode
} from '../../../src/server/services/email-codes';
import {
	rotateOwnerToken,
	storeOwnerToken,
	withOwnerToken,
	type CustodyDeps,
	type OwnerTokenStore,
	type StoredOwnerToken
} from '../../../src/server/services/owner-tokens';
import {
	SESSION_TOUCH_MS,
	createSession,
	getSession,
	revokeSession,
	type KvStore
} from '../../../src/server/services/sessions';
import { productionDeps, resetApiDeps } from '../../../src/server/utils/define-api';
import { createMemoryStore } from '../../../src/server/utils/idempotency';
import { AGENCY, NOW, ORG, SITE, facts, resource } from '../domain/fixtures';
import codePost from '../server/fixtures/api/v1/auth/code.post';
import meGet from '../server/fixtures/api/v1/me.get';
import deployPost, { deploys } from '../server/fixtures/api/v1/sites/[id]/deploys.post';
import { asUser, send, setup } from '../server/fixtures/harness';
import {
	SECRET,
	memoryKv,
	memoryMail,
	useClock,
	type MemoryKv
} from '../server/services/auth-support';

// each finding has a control that passes today, an observation that pins the defect as it is
// now, and an it.fails that states the wanted behaviour; when a fix lands the observation and
// the it.fails flip, and both are removed together

let clock: ReturnType<typeof useClock>;

beforeEach(() => {
	clock = useClock();
});

afterEach(() => {
	clock.stop();
	resetApiDeps();
	deploys.length = 0;
});

const EMAIL = 'ada@example.com';
const tick = () => Promise.resolve();

const wrongGuess = (code: string, offset: number) =>
	String((Number(code) + offset + 1) % 1_000_000).padStart(6, '0');

// #region F1 parallel code guesses

// every caller reads the record before any caller writes it back
function gate(kv: MemoryKv, parties: number): MemoryKv {
	let arrived = 0;
	let release: () => void = () => undefined;
	const open = new Promise<void>((resolve) => (release = resolve));
	return {
		...kv,
		async get(key) {
			const value = await kv.get(key);
			if (key.startsWith('code:')) {
				if (++arrived >= parties) release();
				await open;
			}
			return value;
		}
	};
}

async function sixthGuessIsTheRightCode(parallel: boolean): Promise<boolean> {
	const kv = memoryKv();
	const mail = memoryMail();
	await issueCode(kv, mail, SECRET, EMAIL, clock.now);
	const code = mail.lastCode();
	const now = clock.now;
	const wrong = (i: number) => wrongGuess(code, i);
	if (parallel) {
		const racing = gate(kv, CODE_MAX_ATTEMPTS + 1);
		const misses = Array.from({ length: CODE_MAX_ATTEMPTS }, (_, i) =>
			consumeCode(racing, SECRET, EMAIL, wrong(i), now)
		);
		const hit = consumeCode(racing, SECRET, EMAIL, code, now);
		await Promise.all(misses);
		return hit;
	}
	for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) await consumeCode(kv, SECRET, EMAIL, wrong(i), now);
	return consumeCode(kv, SECRET, EMAIL, code, now);
}

describe('F1 high: parallel guesses pass the five-try lock (email-codes.ts:129-149)', () => {
	it('control: one at a time, the sixth try is refused even with the right code', async () => {
		expect(await sixthGuessIsTheRightCode(false)).toBe(false);
	});

	it('observation: six parallel tries all read zero attempts, so the right code wins', async () => {
		expect(await sixthGuessIsTheRightCode(true)).toBe(true);
	});

	it.fails('wanted: the lock holds under parallel guesses', async () => {
		expect(await sixthGuessIsTheRightCode(true)).toBe(false);
	});
});

// #endregion

// #region F2 reissue resets attempts

async function evaluatedGuessesInOneWindow(): Promise<number> {
	const kv = memoryKv();
	const mail = memoryMail();
	let evaluated = 0;
	const counting: KvStore = {
		...kv,
		async put(key, value, options) {
			if (key.startsWith('code:') && JSON.parse(value).attempts > 0) evaluated++;
			return kv.put(key, value, options);
		}
	};
	for (let round = 0; round < CODE_SEND_RATE.limit; round++) {
		await issueCode(counting, mail, SECRET, EMAIL, clock.now);
		const code = mail.lastCode();
		for (let i = 0; i <= CODE_MAX_ATTEMPTS; i++) {
			await consumeCode(counting, SECRET, EMAIL, wrongGuess(code, i), clock.now);
		}
		clock.advance(CODE_RESEND_COOLDOWN_MS + 1000);
	}
	return evaluated;
}

describe('F2 low: a new code resets the attempt count (email-codes.ts:107-114)', () => {
	it('observation: five codes in one send window give 25 evaluated guesses', async () => {
		expect(await evaluatedGuessesInOneWindow()).toBe(CODE_MAX_ATTEMPTS * CODE_SEND_RATE.limit);
	});

	it.fails('wanted: failed guesses per address stay capped across reissued codes', async () => {
		expect(await evaluatedGuessesInOneWindow()).toBeLessThanOrEqual(CODE_MAX_ATTEMPTS);
	});
});

// #endregion

// #region F3 touch resurrects a revoked session

async function sessionAfterRaceWithRevoke(race: boolean): Promise<boolean> {
	const kv = memoryKv();
	const { token, session } = await createSession(kv, { userId: 'user-1' });
	clock.advance(SESSION_TOUCH_MS + 1000);
	let fired = !race;
	const inFlight: KvStore = {
		...kv,
		async get(key) {
			const value = await kv.get(key);
			if (!fired && key.startsWith('session:token:')) {
				fired = true;
				await revokeSession(kv, 'user-1', session.id);
			}
			return value;
		}
	};
	if (!race) await revokeSession(kv, 'user-1', session.id);
	await getSession(inFlight, token);
	return (await getSession(kv, token)) !== null;
}

describe('F3 low: an in-flight touch undoes a revoke (sessions.ts:200-214)', () => {
	it('control: a revoke with nothing in flight stays revoked', async () => {
		expect(await sessionAfterRaceWithRevoke(false)).toBe(false);
	});

	it('observation: a request that read the session before the revoke writes it back', async () => {
		expect(await sessionAfterRaceWithRevoke(true)).toBe(true);
	});

	it.fails('wanted: a revoked session stays revoked', async () => {
		expect(await sessionAfterRaceWithRevoke(true)).toBe(false);
	});
});

// #endregion

// #region F4 concurrent rotation loses custody

async function custodyAfterRotations(concurrent: boolean) {
	const ring = await loadKeyRing({ KEK_V1: toBase64Url(new Uint8Array(32).fill(7)) });
	const map = new Map<string, StoredOwnerToken>();
	const store: OwnerTokenStore = {
		async get(id) {
			await tick();
			return map.get(id) ?? null;
		},
		async put(id, value) {
			await tick();
			map.set(id, value);
		}
	};
	const deps: CustodyDeps = { store, audit: { append: async () => undefined }, ring };
	const siteId = 'site_aaaaaaaa';
	await storeOwnerToken(deps, { siteId, actor: 'system', token: 'owner-token-0' });
	let onSite = 'owner-token-0';
	const accept = async (next: string, old: string) => {
		if (old !== onSite) throw new Error('the site refused the old token');
		onSite = next;
	};
	const call = { siteId, principal: { kind: 'user' as const, userId: 'user-1' }, stepUp: true };
	if (concurrent) {
		let release: () => void = () => undefined;
		const second = new Promise<void>((resolve) => (release = resolve));
		const a = rotateOwnerToken(deps, call, accept);
		const b = rotateOwnerToken(deps, call, async (next, old) => {
			await second;
			await accept(next, old);
		});
		await a;
		release();
		await b.catch(() => undefined);
	} else {
		await rotateOwnerToken(deps, call, accept);
		await rotateOwnerToken(deps, call, accept);
	}
	const held = await withOwnerToken(
		deps,
		{ siteId, actor: 'system', operation: 'check' },
		async (token) => token
	);
	return { held, onSite };
}

describe('F4 medium: two rotations can leave the platform with a token the site refuses (owner-tokens.ts:119-146)', () => {
	it('control: sequential rotations keep the store and the site in step', async () => {
		const { held, onSite } = await custodyAfterRotations(false);
		expect(held).toBe(onSite);
	});

	it('observation: the loser restores the old record over the winner', async () => {
		const { held, onSite } = await custodyAfterRotations(true);
		expect(held).toBe('owner-token-0');
		expect(onSite).not.toBe('owner-token-0');
	});

	it.fails('wanted: the stored token is the one the site accepts', async () => {
		const { held, onSite } = await custodyAfterRotations(true);
		expect(held).toBe(onSite);
	});
});

// #endregion

// #region F5 limiter flush

async function victimAllowedAfterFlood(
	flood: boolean
): Promise<{ before: boolean; after: boolean }> {
	const { limit } = productionDeps();
	const victim = { routeClass: 'auth-code' as const, key: 'ip:2001:db8::1' };
	for (let i = 0; i < 5; i++) await limit(victim);
	const before = (await limit(victim)).allowed;
	if (flood) {
		for (let i = 0; i < 10_000; i++) await limit({ routeClass: 'read', key: `ip:flood-${i}` });
	}
	return { before, after: (await limit(victim)).allowed };
}

describe('F5 medium: filling the limiter map clears every count (define-api.ts:188-199)', () => {
	it('control: without a flood the sixth request stays refused', async () => {
		expect(await victimAllowedAfterFlood(false)).toEqual({ before: false, after: false });
	});

	it('observation: 10,000 distinct keys reset the window, so the sixth request passes', async () => {
		expect(await victimAllowedAfterFlood(true)).toEqual({ before: false, after: true });
	});

	it.fails('wanted: a flood of other keys never frees a blocked key', async () => {
		expect((await victimAllowedAfterFlood(true)).after).toBe(false);
	});
});

// #endregion

// #region F6 ipv6 keys

async function keysForOneSlash64(): Promise<string[]> {
	const { limits } = setup();
	for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2:ffff::9']) {
		await send(codePost, '/api/v1/auth/code', {
			method: 'POST',
			path: '/api/v1/auth/code',
			headers: { 'cf-connecting-ip': ip },
			json: { email: EMAIL }
		});
	}
	return limits.map((entry) => entry.key);
}

describe('F6 low: the limiter keys each IPv6 address, so one /64 is 2^64 callers (define-api.ts:378-381)', () => {
	it('observation: two addresses in one /64 get two buckets', async () => {
		const keys = await keysForOneSlash64();
		expect(keys).toHaveLength(2);
		expect(keys[0]).not.toBe(keys[1]);
	});

	it.fails('wanted: addresses in one /64 share a bucket', async () => {
		const keys = await keysForOneSlash64();
		expect(keys[0]).toBe(keys[1]);
	});
});

// #endregion

// #region F7 audit tail truncation

interface AuditRow {
	organization_id: string;
	seq: number;
	prev_hash: string;
	hash: string;
	actor: string;
	action: string;
	target: string;
	detail: string;
	created_at: number;
}

function fakeAuditDb(rows: AuditRow[]): CollegeDBClient {
	const db = {
		async first() {
			const last = rows.at(-1);
			return last ? { seq: last.seq, hash: last.hash } : null;
		},
		async run(_org: string, _sql: string, p: unknown[]) {
			rows.push({
				organization_id: p[0] as string,
				seq: p[1] as number,
				prev_hash: p[2] as string,
				hash: p[3] as string,
				actor: p[4] as string,
				action: p[5] as string,
				target: p[6] as string,
				detail: p[7] as string,
				created_at: p[8] as number
			});
		},
		async all(_org: string, _sql: string, p: unknown[]) {
			const after = p[1] as number;
			return { results: rows.filter((row) => row.seq > after).slice(0, p[2] as number) };
		}
	};
	return db as unknown as CollegeDBClient;
}

async function chainOfThree() {
	const rows: AuditRow[] = [];
	const db = fakeAuditDb(rows);
	for (const action of ['member.invite', 'key.create', 'site.delete']) {
		await append(db, ORG, { actor: 'user-1', action, target: 'x' });
	}
	return { rows, db };
}

describe('F7 low: deleting the newest audit rows is not detected (audit.ts:152-176)', () => {
	it('control: an edited row is detected at its index', async () => {
		const { rows, db } = await chainOfThree();
		rows[1]!.actor = 'user-2';
		expect(await verify(db, ORG)).toBe(1);
	});

	it('observation: a chain cut after row 1 verifies as intact', async () => {
		const { rows, db } = await chainOfThree();
		rows.pop();
		expect(await verify(db, ORG)).toBeNull();
	});

	it.fails('wanted: verify notices rows missing from the end', async () => {
		const { rows, db } = await chainOfThree();
		rows.pop();
		expect(await verify(db, ORG)).not.toBeNull();
	});
});

// #endregion

// #region F8 lease lifetime

const authority = (): AuthorityState => ({
	siteId: siteIdSchema.parse(newId('site')),
	epoch: 1,
	generation: 1,
	state: 'active',
	risk: 'established',
	limits: {},
	accessRuleHash: `sha256:${'0'.repeat(64)}`
});

async function admittedAfter(leaseMs: number, waitMs: number): Promise<boolean> {
	const key = await generateSigningKey();
	const state = authority();
	const lease = await issueLease(state, NOW, key.privateKey, { leaseMs });
	const verdict = await checkLease(lease, {
		publicKey: key.publicKey,
		now: NOW + waitMs,
		siteId: state.siteId,
		epoch: state.epoch
	});
	return verdict.ok;
}

describe('F8 low: checkLease sets no ceiling on a lease life (site-auth.ts:165-197)', () => {
	it('control: a default lease is refused once it and the skew have passed', async () => {
		expect(await admittedAfter(30_000, 60_000)).toBe(false);
	});

	it('observation: a one-year lease still admits an hour later', async () => {
		expect(await admittedAfter(365 * 24 * 3_600_000, 3_600_000)).toBe(true);
	});

	it.fails('wanted: the verifier refuses a lease that outlives the stale grace', async () => {
		expect(await admittedAfter(365 * 24 * 3_600_000, 3_600_000)).toBe(false);
	});
});

// #endregion

// #region F9 command audience

describe('F9 low: a signed command names no target node (fleet-link.ts:197-206)', () => {
	it('observation: the command body has no node field', () => {
		expect(Object.keys(commandBodySchema.shape)).not.toContain('nodeId');
	});

	it.fails('wanted: a command is bound to the node it is meant for', () => {
		expect(Object.keys(commandBodySchema.shape)).toContain('nodeId');
	});
});

// #endregion

// #region F10 suspended agency

function delegatedDecision(suspended: boolean): string {
	const created = createDelegation({
		id: 'dlg-1',
		clientOrgId: ORG,
		agencyOrgId: AGENCY,
		role: 'maintainer',
		sites: 'all',
		createdBy: 'owner-1',
		now: NOW - 2000
	});
	if (!created.ok) throw new Error(created.reason);
	const accepted = acceptDelegation(created.delegation, { orgId: AGENCY, now: NOW - 1000 });
	if (!accepted.ok) throw new Error(accepted.reason);
	const decision = authorize({
		principal: { kind: 'user', userId: 'user-1' },
		action: 'site.deploy',
		resource,
		facts: facts({
			delegations: [accepted.delegation],
			agencyMemberships: [{ orgId: AGENCY, role: 'developer' }],
			flags: suspended ? { suspendedOrgIds: [AGENCY] } : {}
		})
	});
	return decision.allow ? `allow via ${decision.via}` : decision.reason;
}

describe('F10 low: a suspended agency still acts on client sites through a delegation (authorize.ts:198-212)', () => {
	it('control: the delegation allows a deploy while the agency is in good standing', () => {
		expect(delegatedDecision(false)).toBe('allow via delegation');
	});

	it('observation: suspending the agency changes nothing', () => {
		expect(delegatedDecision(true)).toBe('allow via delegation');
	});

	it.fails('wanted: the acting agency being suspended denies the action', () => {
		expect(delegatedDecision(true)).not.toMatch(/^allow/);
	});
});

// #endregion

// #region F11 cache-control

describe('F11 low: authenticated JSON carries no cache directive (define-api.ts:322-327)', () => {
	async function header() {
		setup();
		const reply = await send(meGet, '/api/v1/me', { path: '/api/v1/me', headers: asUser });
		expect(reply.status).toBe(200);
		return reply.headers.get('cache-control');
	}

	it('observation: GET /me answers with no Cache-Control', async () => {
		expect(await header()).toBeNull();
	});

	it.fails('wanted: an authenticated response says no-store', async () => {
		expect(await header()).toMatch(/no-store/);
	});
});

// #endregion

// #region F12 concurrent idempotent requests

async function handlerRuns(parallel: boolean): Promise<number> {
	const inner = createMemoryStore();
	let arrived = 0;
	let release: () => void = () => undefined;
	const open = new Promise<void>((resolve) => (release = resolve));
	setup({
		deps: {
			idempotency: {
				async get(key) {
					const record = await inner.get(key);
					if (parallel) {
						if (++arrived >= 2) release();
						await open;
					}
					return record;
				},
				put: (key, record) => inner.put(key, record)
			}
		}
	});
	const request = () =>
		send(deployPost, '/api/v1/sites/:id/deploys', {
			method: 'POST',
			path: `/api/v1/sites/${SITE}/deploys`,
			headers: { ...asUser, 'idempotency-key': 'key-12345678' },
			json: { ref: 'main' }
		});
	if (parallel) await Promise.all([request(), request()]);
	else {
		await request();
		await request();
	}
	return deploys.length;
}

describe('F12 medium: two requests with one Idempotency-Key both run the handler (define-api.ts:501-511)', () => {
	it('control: one after the other, the second is a replay', async () => {
		expect(await handlerRuns(false)).toBe(1);
	});

	it('observation: two in flight together both pass the lookup', async () => {
		expect(await handlerRuns(true)).toBe(2);
	});

	it.fails('wanted: one run per key', async () => {
		expect(await handlerRuns(true)).toBe(1);
	});
});

// #endregion
