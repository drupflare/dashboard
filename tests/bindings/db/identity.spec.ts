import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuplicateRowError, ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	createIdentity,
	createUser,
	getIdentityByProviderSubject,
	getUserByEmail,
	getUserById,
	setIdentityVerified
} from '../../../src/server/db/repos/identity';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	db = await ensureCollegeDB(env);
});

afterAll(() => harness.close());

const uniqueEmail = () => `person-${crypto.randomUUID()}@example.test`;

describe('user repository', () => {
	it('stores the email in lower case and reads the user back by id', async () => {
		const email = uniqueEmail().toUpperCase();
		const user = await createUser(db, { email, displayName: 'Ada' });
		expect(user.email).toBe(email.toLowerCase());
		expect(await getUserById(db, user.id)).toEqual(user);
	});

	it('finds a user by any casing of the email and returns null for an unknown one', async () => {
		const email = uniqueEmail();
		const user = await createUser(db, { email });
		expect((await getUserByEmail(db, email.toUpperCase()))?.id).toBe(user.id);
		expect(await getUserByEmail(db, uniqueEmail())).toBeNull();
	});

	it('refuses an email that is already in use', async () => {
		const email = uniqueEmail();
		await createUser(db, { email });
		await expect(createUser(db, { email: email.toUpperCase() })).rejects.toBeInstanceOf(
			DuplicateRowError
		);
	});

	it('returns null for an unknown id', async () => {
		expect(await getUserById(db, crypto.randomUUID())).toBeNull();
	});
});

describe('identity repository', () => {
	it('reads an identity back by provider and subject with its verified flag', async () => {
		const user = await createUser(db, { email: uniqueEmail() });
		const subject = crypto.randomUUID();
		const identity = await createIdentity(db, {
			userId: user.id,
			provider: 'github',
			providerSubject: subject,
			email: user.email,
			verified: true
		});
		const found = await getIdentityByProviderSubject(db, 'github', subject);
		expect(found).toEqual(identity);
		expect(found?.verified).toBe(true);
	});

	it('returns null when the provider or the subject does not match', async () => {
		const user = await createUser(db, { email: uniqueEmail() });
		const subject = crypto.randomUUID();
		await createIdentity(db, {
			userId: user.id,
			provider: 'google',
			providerSubject: subject,
			email: null,
			verified: false
		});
		expect(await getIdentityByProviderSubject(db, 'github', subject)).toBeNull();
		expect(await getIdentityByProviderSubject(db, 'google', crypto.randomUUID())).toBeNull();
	});

	it('refuses a second identity for the same provider subject', async () => {
		const user = await createUser(db, { email: uniqueEmail() });
		const subject = crypto.randomUUID();
		const input = {
			userId: user.id,
			provider: 'microsoft',
			providerSubject: subject,
			email: null,
			verified: false
		};
		await createIdentity(db, input);
		await expect(createIdentity(db, input)).rejects.toBeInstanceOf(DuplicateRowError);
	});

	it('changes the verified flag and reports an unknown id as not changed', async () => {
		const user = await createUser(db, { email: uniqueEmail() });
		const subject = crypto.randomUUID();
		const identity = await createIdentity(db, {
			userId: user.id,
			provider: 'email-otp',
			providerSubject: subject,
			email: user.email,
			verified: false
		});
		expect(await setIdentityVerified(db, identity.id, true)).toBe(true);
		expect((await getIdentityByProviderSubject(db, 'email-otp', subject))?.verified).toBe(true);
		expect(await setIdentityVerified(db, crypto.randomUUID(), true)).toBe(false);
	});
});
