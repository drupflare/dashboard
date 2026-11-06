import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	IDEMPOTENCY_CLAIM_TTL_MS,
	IDEMPOTENCY_RECORD_TTL_MS,
	checkIdempotency,
	collegeIdempotencyStore
} from '../../../src/server/utils/idempotency';
import { useClock } from '../../unit/server/services/auth-support';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let open: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;
let clock: ReturnType<typeof useClock>;

beforeAll(async () => {
	open = await openBindings();
	env = open.env;
	db = await ensureCollegeDB(env);
});

afterAll(() => open.close());

beforeEach(() => {
	clock = useClock();
});

afterEach(() => clock.stop());

const store = () => collegeIdempotencyStore(async () => db);
const freshKey = (org = 'org-1') => `user:user-1|${org}|key-${crypto.randomUUID()}`;
const kinds = (claims: { kind: string }[]) => claims.map((claim) => claim.kind);

async function rows(): Promise<number> {
	const row = await env.DB.prepare('SELECT count(*) AS n FROM idempotency_keys').first<{
		n: number;
	}>();
	return row?.n ?? 0;
}

describe('idempotency claims against real D1', () => {
	it('give a free key to the first caller and report it pending to the next', async () => {
		const key = freshKey();
		expect(await store().claim(key, 'fp')).toEqual({ kind: 'claimed' });
		expect(await store().claim(key, 'fp')).toEqual({ kind: 'pending', fingerprint: 'fp' });
	});

	it('let exactly one of twenty parallel claims take the key', async () => {
		const key = freshKey();
		const claims = await Promise.all(
			Array.from({ length: 20 }, () => store().claim(key, 'fp'))
		);
		expect(kinds(claims).filter((kind) => kind === 'claimed')).toHaveLength(1);
		expect(kinds(claims).filter((kind) => kind === 'pending')).toHaveLength(19);
	});

	it('store a response and hand it back with its body', async () => {
		const key = freshKey();
		await store().claim(key, 'fp');
		await store().put(key, { fingerprint: 'fp', status: 202, body: { operationId: 'op_1' } });
		expect(await store().claim(key, 'fp')).toEqual({
			kind: 'stored',
			record: { fingerprint: 'fp', status: 202, body: { operationId: 'op_1' } }
		});
	});

	it('round-trip a response with no body', async () => {
		const key = freshKey();
		await store().claim(key, 'fp');
		await store().put(key, { fingerprint: 'fp', status: 204, body: null });
		expect(await store().claim(key, 'fp')).toMatchObject({
			kind: 'stored',
			record: { status: 204, body: null }
		});
	});

	it('free a released claim and keep a completed record when release comes late', async () => {
		const key = freshKey();
		await store().claim(key, 'fp');
		await store().release(key);
		expect(await store().claim(key, 'fp')).toEqual({ kind: 'claimed' });
		await store().put(key, { fingerprint: 'fp', status: 200, body: null });
		await store().release(key);
		expect((await store().claim(key, 'fp')).kind).toBe('stored');
	});

	it('hand an expired claim to a new caller and an expired record too', async () => {
		const key = freshKey();
		await store().claim(key, 'fp');
		clock.advance(IDEMPOTENCY_CLAIM_TTL_MS - 1);
		expect((await store().claim(key, 'fp')).kind).toBe('pending');
		clock.advance(1);
		expect(await store().claim(key, 'other')).toEqual({ kind: 'claimed' });
		await store().put(key, { fingerprint: 'other', status: 200, body: null });
		clock.advance(IDEMPOTENCY_RECORD_TTL_MS);
		expect(await store().claim(key, 'fp')).toEqual({ kind: 'claimed' });
	});

	it('keep one client key apart across organisations and across callers', async () => {
		const suffix = crypto.randomUUID();
		const a = `user:user-1|org-1|key-${suffix}`;
		const b = `user:user-1|org-2|key-${suffix}`;
		const c = `user:user-2|org-1|key-${suffix}`;
		expect(await store().claim(a, 'fp')).toEqual({ kind: 'claimed' });
		expect(await store().claim(b, 'fp')).toEqual({ kind: 'claimed' });
		expect(await store().claim(c, 'fp')).toEqual({ kind: 'claimed' });
	});

	it('write one row per key however many callers race', async () => {
		const before = await rows();
		const key = freshKey();
		await Promise.all(Array.from({ length: 10 }, () => store().claim(key, 'fp')));
		expect((await rows()) - before).toBe(1);
	});

	it('refuse a held key with another fingerprint through the check', async () => {
		const key = freshKey();
		await store().claim(key, 'fp');
		await expect(checkIdempotency(store(), key, 'other')).rejects.toMatchObject({
			code: 'unprocessable'
		});
		expect(await checkIdempotency(store(), key, 'fp')).toEqual({ kind: 'pending' });
	});
});
