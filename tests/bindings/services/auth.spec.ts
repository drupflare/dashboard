import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	collegeDirectory,
	createAccount,
	requestCode,
	verifyCode
} from '../../../src/server/services/auth';
import { CODE_RESEND_COOLDOWN_MS } from '../../../src/server/services/email-codes';
import { harness as fakes, useClock } from '../../unit/server/services/auth-support';
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

const uniqueEmail = () => `person-${crypto.randomUUID()}@example.test`;

// real d1 shards behind the directory; kv, mail and the bot check stay fake so the code flow is exact
function world() {
	const f = fakes();
	return { f, deps: { ...f, directory: collegeDirectory(async () => db) } };
}

async function count(sql: string, ...bindings: unknown[]): Promise<number> {
	const row = await env.DB.prepare(sql)
		.bind(...bindings)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function counts(email: string, userId: string) {
	return {
		users: await count('SELECT count(*) AS n FROM users WHERE email = ?', email),
		orgs: await count(
			'SELECT count(*) AS n FROM organizations WHERE created_by = ? AND personal = 1',
			userId
		),
		members: await count(
			`SELECT count(*) AS n FROM members WHERE user_id = ? AND role = 'owner'`,
			userId
		),
		audits: await count(
			`SELECT count(*) AS n FROM audit_log WHERE actor = ? AND action = 'account.create'`,
			userId
		)
	};
}

const ONE_OF_EACH = { users: 1, orgs: 1, members: 1, audits: 1 };

describe('verifyCode against real D1', () => {
	it('creates one user, one personal organisation, one owner membership and one audit row', async () => {
		const { f, deps } = world();
		const email = uniqueEmail();
		await requestCode(deps, { email });
		const result = await verifyCode(deps, { email, code: f.mail.lastCode() });
		expect(result.isNew).toBe(true);
		expect(await counts(email, result.user.id)).toEqual(ONE_OF_EACH);
	});

	it('does not duplicate anything when the same address signs in again', async () => {
		const { f, deps } = world();
		const email = uniqueEmail();
		await requestCode(deps, { email });
		const first = await verifyCode(deps, { email, code: f.mail.lastCode() });
		clock.advance(CODE_RESEND_COOLDOWN_MS);
		await requestCode(deps, { email });
		const second = await verifyCode(deps, { email, code: f.mail.lastCode() });
		expect(second.isNew).toBe(false);
		expect(second.user.id).toBe(first.user.id);
		expect(await counts(email, first.user.id)).toEqual(ONE_OF_EACH);
	});

	it('lets exactly one of five parallel verifications with one code sign in', async () => {
		const { f, deps } = world();
		const email = uniqueEmail();
		await requestCode(deps, { email });
		const code = f.mail.lastCode();
		const results = await Promise.allSettled(
			Array.from({ length: 5 }, () => verifyCode(deps, { email, code }))
		);
		const signedIn = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
		expect(signedIn).toHaveLength(1);
		expect(signedIn[0]!.isNew).toBe(true);
		expect(await counts(email, signedIn[0]!.user.id)).toEqual(ONE_OF_EACH);
	});

	it('leaves exactly one of each when parallel sign-ups race on a new address', async () => {
		const { deps } = world();
		const email = uniqueEmail();
		const made = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				createAccount(deps.directory, email, i % 2 === 0 ? 'email-code' : 'github')
			)
		);
		const winners = made.filter((user) => user !== null);
		expect(winners).toHaveLength(1);
		expect(await counts(email, winners[0]!.id)).toEqual(ONE_OF_EACH);
	});
});
