import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	generateSigningKey,
	newId,
	siteId as siteIdSchema,
	toBase64Url
} from '../../../contracts/src/common';
import {
	commandBodySchema,
	signEnvelope,
	verifyEnvelope,
	type UnsignedEnvelope
} from '../../../contracts/src/fleet-link';
import {
	MAX_LEASE_MS,
	checkLease,
	issueLease,
	type AuthorityState
} from '../../../contracts/src/site-auth';
import { authorize } from '../../../src/server/domain/authorize';
import { acceptDelegation, createDelegation } from '../../../src/server/domain/delegation';
import { append, verify } from '../../../src/server/services/audit';
import {
	CODE_ATTEMPT_RATE,
	CODE_MAX_ATTEMPTS,
	CODE_RESEND_COOLDOWN_MS,
	CODE_SEND_RATE,
	consumeCode,
	issueCode
} from '../../../src/server/services/email-codes';
import {
	OwnerTokenConflictError,
	rotateOwnerToken,
	storeOwnerToken,
	withOwnerToken,
	type CustodyDeps
} from '../../../src/server/services/owner-tokens';
import {
	SESSION_TOUCH_MS,
	createSession,
	getSession,
	revokeSession,
	type KvStore
} from '../../../src/server/services/sessions';
import {
	MAX_TRACKED_KEYS,
	productionDeps,
	resetApiDeps
} from '../../../src/server/utils/define-api';
import { createMemoryStore } from '../../../src/server/utils/idempotency';
import { loadKeyRing } from '../../../src/shared/custody/envelope';
import { AGENCY, NOW, ORG, SITE, facts, resource } from '../domain/fixtures';
import codePost from '../server/fixtures/api/v1/auth/code.post';
import meGet from '../server/fixtures/api/v1/me.get';
import deployPost, { deploys } from '../server/fixtures/api/v1/sites/[id]/deploys.post';
import { asUser, send, setup } from '../server/fixtures/harness';
import { fakeAuditDb, memoryHeads, type AuditRow } from '../server/services/audit-support';
import {
	SECRET,
	memoryAttempts,
	memoryKv,
	memoryMail,
	memoryOnce,
	useClock,
	type MemoryOnce
} from '../server/services/auth-support';
import { MemoryOwnerTokenStore } from '../server/services/custody-support';

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

const wrongGuess = (code: string, offset: number) =>
	String((Number(code) + offset + 1) % 1_000_000).padStart(6, '0');

// #region parallel code guesses

// every caller reads the code record before any caller goes on to claim or take it
function gate(once: MemoryOnce, parties: number): MemoryOnce {
	let arrived = 0;
	let release: () => void = () => undefined;
	const open = new Promise<void>((resolve) => (release = resolve));
	return {
		...once,
		async get(key, now) {
			const value = await once.get(key, now);
			if (key.startsWith('code:')) {
				if (++arrived >= parties) release();
				await open;
			}
			return value;
		}
	};
}

async function issued() {
	const once = memoryOnce();
	const mail = memoryMail();
	const attempts = memoryAttempts();
	await issueCode(once, mail, SECRET, EMAIL, clock.now);
	return { once, attempts, code: mail.lastCode() };
}

async function rightCodeAfterWrongGuesses(parallel: boolean): Promise<boolean> {
	const { once, attempts, code } = await issued();
	const guesses = Array.from({ length: CODE_MAX_ATTEMPTS }, (_, i) => wrongGuess(code, i));
	const now = clock.now;
	if (parallel) {
		const racing = gate(once, CODE_MAX_ATTEMPTS);
		await Promise.all(
			guesses.map((guess) => consumeCode(racing, attempts, SECRET, EMAIL, guess, now))
		);
	} else {
		for (const guess of guesses) await consumeCode(once, attempts, SECRET, EMAIL, guess, now);
	}
	return consumeCode(once, attempts, SECRET, EMAIL, code, now);
}

describe('email code guesses', () => {
	it('five wrong guesses one at a time lock the code', async () => {
		expect(await rightCodeAfterWrongGuesses(false)).toBe(false);
	});

	it('five parallel wrong guesses lock the code', async () => {
		expect(await rightCodeAfterWrongGuesses(true)).toBe(false);
	});

	it('grants no more than the allowed attempts to guesses made in parallel', async () => {
		const { once, attempts, code } = await issued();
		const racing = gate(once, CODE_MAX_ATTEMPTS * 3);
		const results = await Promise.all(
			Array.from({ length: CODE_MAX_ATTEMPTS * 3 }, (_, i) =>
				consumeCode(racing, attempts, SECRET, EMAIL, wrongGuess(code, i), clock.now)
			)
		);
		expect(results.every((accepted) => accepted === false)).toBe(true);
		expect(attempts.granted).toHaveLength(CODE_MAX_ATTEMPTS);
	});
});

// #endregion

// #region reissued codes

async function guessesGrantedInOneSendWindow(): Promise<number> {
	const once = memoryOnce();
	const mail = memoryMail();
	const attempts = memoryAttempts();
	for (let round = 0; round < CODE_SEND_RATE.limit; round++) {
		await issueCode(once, mail, SECRET, EMAIL, clock.now);
		const code = mail.lastCode();
		for (let i = 0; i <= CODE_MAX_ATTEMPTS; i++) {
			await consumeCode(once, attempts, SECRET, EMAIL, wrongGuess(code, i), clock.now);
		}
		clock.advance(CODE_RESEND_COOLDOWN_MS + 1000);
	}
	return attempts.granted.length;
}

describe('email code guesses across reissued codes', () => {
	it('one code allows exactly the allowed attempts', async () => {
		const { once, attempts, code } = await issued();
		for (let i = 0; i <= CODE_MAX_ATTEMPTS; i++) {
			await consumeCode(once, attempts, SECRET, EMAIL, wrongGuess(code, i), clock.now);
		}
		expect(attempts.granted).toHaveLength(CODE_MAX_ATTEMPTS);
	});

	it('failed guesses per address stay capped across reissued codes', async () => {
		expect(await guessesGrantedInOneSendWindow()).toBeLessThanOrEqual(CODE_MAX_ATTEMPTS);
	});

	it('lets the address try again once the attempt window has passed', async () => {
		const { once, attempts, code } = await issued();
		for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) {
			await consumeCode(once, attempts, SECRET, EMAIL, wrongGuess(code, i), clock.now);
		}
		clock.advance(CODE_ATTEMPT_RATE.windowMs);
		const mail = memoryMail();
		await issueCode(once, mail, SECRET, EMAIL, clock.now);
		expect(await consumeCode(once, attempts, SECRET, EMAIL, mail.lastCode(), clock.now)).toBe(
			true
		);
	});
});

// #endregion

// #region session touch

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

describe('session touch and revoke', () => {
	it('a revoke with nothing in flight stays revoked', async () => {
		expect(await sessionAfterRaceWithRevoke(false)).toBe(false);
	});

	it('a request that read the session before the revoke does not bring it back', async () => {
		expect(await sessionAfterRaceWithRevoke(true)).toBe(false);
	});

	it('still touches a session that nobody revoked', async () => {
		const kv = memoryKv();
		const { token, session } = await createSession(kv, { userId: 'user-1' });
		clock.advance(SESSION_TOUCH_MS + 1000);
		const touched = await getSession(kv, token);
		expect(touched?.id).toBe(session.id);
		expect(touched?.lastSeenAt).toBe(clock.now);
	});
});

// #endregion

// #region owner token rotation

async function custodyAfterRotations(concurrent: boolean) {
	const ring = await loadKeyRing({ KEK_V1: toBase64Url(new Uint8Array(32).fill(7)) });
	const store = new MemoryOwnerTokenStore(true);
	const deps: CustodyDeps = { store, audit: { append: async () => undefined }, ring };
	const siteId = 'site_aaaaaaaa';
	await storeOwnerToken(deps, { siteId, actor: 'system', token: 'owner-token-0' });
	let onSite = 'owner-token-0';
	const accept = async (next: string, old: string) => {
		if (old !== onSite) throw new Error('the site refused the old token');
		onSite = next;
	};
	const call = { siteId, principal: { kind: 'user' as const, userId: 'user-1' }, stepUp: true };
	let outcomes: PromiseSettledResult<void>[] = [];
	if (concurrent) {
		let release: () => void = () => undefined;
		const second = new Promise<void>((resolve) => (release = resolve));
		const a = rotateOwnerToken(deps, call, accept);
		const b = rotateOwnerToken(deps, call, async (next, old) => {
			await second;
			await accept(next, old);
		});
		a.then(release, release);
		outcomes = await Promise.allSettled([a, b]);
	} else {
		await rotateOwnerToken(deps, call, accept);
		await rotateOwnerToken(deps, call, accept);
	}
	const held = await withOwnerToken(
		deps,
		{ siteId, actor: 'system', operation: 'check' },
		async (token) => token
	);
	return { held, onSite, outcomes };
}

describe('owner token rotation', () => {
	it('sequential rotations keep the store and the site in step', async () => {
		const { held, onSite } = await custodyAfterRotations(false);
		expect(held).toBe(onSite);
	});

	it('the stored token is the one the site accepts after two rotations at once', async () => {
		const { held, onSite } = await custodyAfterRotations(true);
		expect(held).toBe(onSite);
		expect(onSite).not.toBe('owner-token-0');
	});

	it('the rotation that loses gets a typed conflict', async () => {
		const { outcomes } = await custodyAfterRotations(true);
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		const lost = outcomes.find((outcome) => outcome.status === 'rejected');
		expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(OwnerTokenConflictError);
	});
});

// #endregion

// #region limiter

async function victimAllowedAfterFlood(
	flood: boolean
): Promise<{ before: boolean; after: boolean }> {
	const { limit } = productionDeps();
	const victim = { routeClass: 'auth-code' as const, key: 'ip:2001:db8::1' };
	for (let i = 0; i < 5; i++) await limit(victim);
	const before = (await limit(victim)).allowed;
	if (flood) {
		for (let i = 0; i < MAX_TRACKED_KEYS * 2; i++) {
			await limit({ routeClass: 'read', key: `ip:flood-${i}` });
		}
	}
	return { before, after: (await limit(victim)).allowed };
}

describe('rate limiter memory', () => {
	it('without a flood the sixth request stays refused', async () => {
		expect(await victimAllowedAfterFlood(false)).toEqual({ before: false, after: false });
	});

	it('a flood of other keys never frees a blocked key', async () => {
		expect(await victimAllowedAfterFlood(true)).toEqual({ before: false, after: false });
	});
});

async function keysFor(addresses: string[]): Promise<string[]> {
	const { limits } = setup();
	for (const ip of addresses) {
		await send(codePost, '/api/v1/auth/code', {
			method: 'POST',
			path: '/api/v1/auth/code',
			headers: { 'cf-connecting-ip': ip },
			json: { email: EMAIL }
		});
	}
	return limits.map((entry) => entry.key).filter((key) => key.startsWith('ip:'));
}

describe('rate limiter keys', () => {
	it('addresses in one /64 share a bucket', async () => {
		const keys = await keysFor(['2001:db8:1:2::1', '2001:db8:1:2:ffff::9']);
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(keys[1]);
	});

	it('addresses in different /64 networks keep separate buckets', async () => {
		const keys = await keysFor(['2001:db8:1:2::1', '2001:db8:1:3::1']);
		expect(keys[0]).not.toBe(keys[1]);
	});

	it('ipv4 addresses stay one bucket each', async () => {
		const keys = await keysFor(['203.0.113.9', '203.0.113.10']);
		expect(keys).toEqual(['ip:203.0.113.9', 'ip:203.0.113.10']);
	});
});

// #endregion

// #region audit chain head

async function chainOfThree() {
	const rows: AuditRow[] = [];
	const db = fakeAuditDb(rows);
	const heads = memoryHeads();
	for (const action of ['member.invite', 'key.create', 'site.delete']) {
		await append(db, ORG, { actor: 'user-1', action, target: 'x' }, heads);
	}
	return { rows, db, heads };
}

describe('audit chain verification', () => {
	it('an edited row is detected at its index', async () => {
		const { rows, db, heads } = await chainOfThree();
		rows[1]!.actor = 'user-2';
		expect(await verify(db, ORG, heads)).toBe(1);
	});

	it('an untouched chain verifies against its head', async () => {
		const { db, heads } = await chainOfThree();
		expect(await verify(db, ORG, heads)).toBeNull();
	});

	it('rows missing from the end are noticed', async () => {
		const { rows, db, heads } = await chainOfThree();
		rows.pop();
		expect(await verify(db, ORG, heads)).not.toBeNull();
	});
});

// #endregion

// #region lease lifetime

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

describe('lease lifetime', () => {
	it('a default lease is refused once it and the skew have passed', async () => {
		expect(await admittedAfter(30_000, 60_000)).toBe(false);
	});

	it('a lease at the maximum life still admits', async () => {
		expect(await admittedAfter(MAX_LEASE_MS, 1000)).toBe(true);
	});

	it('the verifier refuses a lease that outlives the maximum', async () => {
		expect(await admittedAfter(MAX_LEASE_MS + 1, 1000)).toBe(false);
		expect(await admittedAfter(365 * 24 * 3_600_000, 3_600_000)).toBe(false);
	});
});

// #endregion

// #region command audience

async function commandAt(nodeId: string, receiver: string | undefined) {
	const dashboard = await generateSigningKey();
	const message = await signEnvelope(
		{
			v: 1,
			id: 'msg_cmd_900001',
			type: 'command',
			ts: 100,
			seq: 1,
			ack: 0,
			body: {
				nodeId,
				opId: newId('op'),
				stepId: 's',
				idempotencyKey: 'k',
				expiresAt: 500,
				class: 'safe',
				approval: 'local',
				action: 'a',
				params: {}
			}
		} as UnsignedEnvelope,
		dashboard.privateKey
	);
	return verifyEnvelope(message, {
		publicKey: dashboard.publicKey,
		direction: 'server',
		now: 100,
		...(receiver === undefined ? {} : { nodeId: receiver })
	});
}

describe('command audience', () => {
	const node = newId('nod');

	it('the command body names a node', () => {
		expect(Object.keys(commandBodySchema.shape)).toContain('nodeId');
	});

	it('a command is accepted by the node it names', async () => {
		expect((await commandAt(node, node)).ok).toBe(true);
	});

	it('a command is refused by every other node', async () => {
		expect(await commandAt(node, newId('nod'))).toEqual({ ok: false, code: 'wrong_node' });
		expect(await commandAt(node, undefined)).toEqual({ ok: false, code: 'wrong_node' });
	});
});

// #endregion

// #region suspended agency

function delegatedDecision(flags: { suspendedOrgIds?: string[] }): string {
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
			flags
		})
	});
	return decision.allow ? `allow via ${decision.via}` : decision.reason;
}

describe('delegation and suspension', () => {
	it('the delegation allows a deploy while the agency is in good standing', () => {
		expect(delegatedDecision({})).toBe('allow via delegation');
	});

	it('the acting agency being suspended denies the action', () => {
		expect(delegatedDecision({ suspendedOrgIds: [AGENCY] })).toBe('org_suspended');
	});

	it('the client organisation being suspended denies the action', () => {
		expect(delegatedDecision({ suspendedOrgIds: [ORG] })).toBe('org_suspended');
	});

	it('an unrelated suspended organisation changes nothing', () => {
		expect(delegatedDecision({ suspendedOrgIds: ['org-elsewhere'] })).toBe(
			'allow via delegation'
		);
	});
});

// #endregion

// #region cache control

describe('cache control', () => {
	async function meHeaders(headers: Record<string, string>) {
		setup();
		const reply = await send(meGet, '/api/v1/me', { path: '/api/v1/me', headers });
		return { status: reply.status, cache: reply.headers.get('cache-control') };
	}

	it('an authenticated response says no-store', async () => {
		expect(await meHeaders(asUser)).toEqual({ status: 200, cache: 'no-store' });
	});

	it('a refusal on a protected route says no-store too', async () => {
		expect(await meHeaders({})).toEqual({ status: 401, cache: 'no-store' });
	});

	it('a route marked public gets no default directive', async () => {
		setup();
		const reply = await send(codePost, '/api/v1/auth/code', {
			method: 'POST',
			path: '/api/v1/auth/code',
			headers: { 'cf-connecting-ip': '192.0.2.5' },
			json: { email: EMAIL }
		});
		expect(reply.status).toBe(202);
		expect(reply.headers.get('cache-control')).toBeNull();
	});
});

// #endregion

// #region idempotent requests

async function parallelDeploys(parallel: boolean) {
	const inner = createMemoryStore();
	let arrived = 0;
	let release: () => void = () => undefined;
	const open = new Promise<void>((resolve) => (release = resolve));
	setup({
		deps: {
			idempotency: {
				async claim(key, fingerprint) {
					if (parallel) {
						if (++arrived >= 2) release();
						await open;
					}
					return inner.claim(key, fingerprint);
				},
				put: (key, record) => inner.put(key, record),
				release: (key) => inner.release(key)
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
	const replies = parallel
		? await Promise.all([request(), request()])
		: [await request(), await request()];
	return { runs: deploys.length, replies };
}

describe('idempotent requests', () => {
	it('one after the other, the second is a replay', async () => {
		const { runs, replies } = await parallelDeploys(false);
		expect(runs).toBe(1);
		expect(replies[1]!.headers.get('idempotency-replayed')).toBe('true');
	});

	it('two in flight together run the handler once', async () => {
		expect((await parallelDeploys(true)).runs).toBe(1);
	});

	it('the request that did not run is told the first is still pending', async () => {
		const { replies } = await parallelDeploys(true);
		expect(replies.map((reply) => reply.status).sort()).toEqual([202, 409]);
		const refused = replies.find((reply) => reply.status === 409)!;
		expect(refused.json).toMatchObject({
			code: 'conflict',
			details: { reason: 'idempotency_pending' }
		});
		expect(refused.headers.get('retry-after')).toBe('1');
	});
});

// #endregion
