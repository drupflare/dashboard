import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OAUTH_PROVIDERS, type OAuthProvider } from '../../../../src/server/integrations/oauth';
import {
	authenticationOptions,
	registrationOptions
} from '../../../../src/server/integrations/webauthn';
import {
	LINK_TTL_MS,
	confirmLink,
	connectIdentity,
	finishPasskeyRegistration,
	listIdentities,
	removePasskey,
	renamePasskey,
	requireFresh,
	signInWithPasskey,
	signInWithProvider,
	startPasskeyRegistration,
	unlinkIdentity
} from '../../../../src/server/services/identities';
import { getSession, listSessions } from '../../../../src/server/services/sessions';
import { ApiError } from '../../../../src/shared/errors';
import { CONNECT_ONLY_PROVIDERS } from '../../../../src/shared/oauth';
import { STEP_UP_WINDOW_MS } from '../../../../src/shared/permissions';
import { makeAuthenticator, type Authenticator } from '../integrations/webauthn-support';
import { useClock } from './auth-support';
import { identityHarness, type IdentityHarness } from './identities-support';

let clock: ReturnType<typeof useClock>;
let h: IdentityHarness;

beforeEach(() => {
	clock = useClock();
	h = identityHarness();
});

afterEach(() => clock.stop());

const profile = (
	over: Partial<{ subject: string; email: string | null; emailVerified: boolean }> = {}
) => ({
	subject: '4242',
	email: 'ada@example.com',
	emailVerified: true,
	name: 'Ada',
	...over
});

async function existingUser(email = 'ada@example.com') {
	const user = await h.directory.createUser(email);
	await h.directory.ensurePersonalOrganization(user);
	return user;
}

async function expectFailure(run: Promise<unknown>, code: string, message?: string) {
	const error = await run.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(ApiError);
	expect((error as ApiError).code).toBe(code);
	if (message) expect((error as ApiError).message).toBe(message);
	return error as ApiError;
}

const sessionKeys = () => h.kv.keys().filter((name) => name.startsWith('session:'));

// a provider that gives no address to start an account from is covered on its own below
const EMAIL_PROVIDERS = OAUTH_PROVIDERS.filter(
	(provider) => !CONNECT_ONLY_PROVIDERS.includes(provider)
);

describe.each(EMAIL_PROVIDERS)('%s sign-in', (provider: OAuthProvider) => {
	it('creates an account with its personal organisation, owner, identity and audit row', async () => {
		const result = await signInWithProvider(h, provider, profile());
		expect(result.status).toBe('signed_in');
		if (result.status !== 'signed_in') return;
		expect(result.isNew).toBe(true);
		expect(h.directory.users).toHaveLength(1);
		expect(h.directory.orgs).toHaveLength(1);
		expect(h.directory.orgs[0]?.personal).toBe(true);
		expect(h.directory.members).toHaveLength(1);
		expect(h.directory.members[0]).toMatchObject({ userId: result.user.id, role: 'owner' });
		expect(h.store.identities).toEqual([
			expect.objectContaining({
				userId: result.user.id,
				provider,
				providerSubject: '4242',
				email: 'ada@example.com',
				verified: true
			})
		]);
		expect(h.directory.audits).toEqual([
			{
				organizationId: h.directory.orgs[0]?.id,
				input: {
					actor: result.user.id,
					action: 'account.create',
					target: result.user.id,
					detail: { method: provider }
				}
			}
		]);
		expect((await getSession(h.kv, result.token))?.userId).toBe(result.user.id);
	});

	it('signs the same identity back in without creating anything', async () => {
		const first = await signInWithProvider(h, provider, profile());
		const again = await signInWithProvider(h, provider, profile());
		expect(again.status).toBe('signed_in');
		if (first.status !== 'signed_in' || again.status !== 'signed_in') return;
		expect(again.isNew).toBe(false);
		expect(again.user.id).toBe(first.user.id);
		expect(h.directory.users).toHaveLength(1);
		expect(h.directory.orgs).toHaveLength(1);
		expect(h.store.identities).toHaveLength(1);
		expect(h.directory.audits).toHaveLength(1);
	});

	it('keeps a known identity signed in after the provider email changes', async () => {
		await signInWithProvider(h, provider, profile());
		const later = await signInWithProvider(h, provider, profile({ email: 'new@example.com' }));
		expect(later.status).toBe('signed_in');
		expect(h.directory.users).toHaveLength(1);
	});

	it('never merges into an account with the same verified email', async () => {
		const owner = await existingUser();
		const result = await signInWithProvider(h, provider, profile());
		expect(result).toMatchObject({
			status: 'link_required',
			provider,
			email: 'ada@example.com'
		});
		expect(h.store.identities).toEqual([]);
		expect(h.directory.users).toHaveLength(1);
		expect(h.directory.orgs).toHaveLength(1);
		expect(sessionKeys()).toEqual([]);
		expect(await listSessions(h.kv, owner.id)).toEqual([]);
		expect(h.directory.audits).toEqual([]);
	});

	it('matches the email without regard to case and spaces', async () => {
		await existingUser('ada@example.com');
		const result = await signInWithProvider(
			h,
			provider,
			profile({ email: '  ADA@Example.COM ' })
		);
		expect(result.status).toBe('link_required');
	});

	it('refuses an unverified email without creating or matching anything', async () => {
		await existingUser();
		const error = await expectFailure(
			signInWithProvider(h, provider, profile({ emailVerified: false })),
			'forbidden'
		);
		expect(error.details).toEqual({ requires: 'verified-email' });
		expect(h.store.identities).toEqual([]);
		expect(h.directory.users).toHaveLength(1);
		expect(sessionKeys()).toEqual([]);
		expect(h.once.keys().filter((name) => name.startsWith('link:'))).toEqual([]);
	});

	it('refuses an unverified email on a new address without creating an account', async () => {
		await expectFailure(
			signInWithProvider(h, provider, profile({ emailVerified: false })),
			'forbidden'
		);
		expect(h.directory.users).toEqual([]);
	});

	it('refuses a profile with no email', async () => {
		await expectFailure(
			signInWithProvider(h, provider, profile({ email: null, emailVerified: false })),
			'forbidden'
		);
		expect(h.directory.users).toEqual([]);
	});
});

describe('sign-up races', () => {
	it('asks for a link when a rival creates the account between the lookup and the insert', async () => {
		const find = h.directory.findUserByEmail.bind(h.directory);
		let first = true;
		h.directory.findUserByEmail = async (email) => {
			const found = await find(email);
			if (first) {
				first = false;
				await existingUser(email);
			}
			return found;
		};
		const result = await signInWithProvider(h, 'github', profile());
		expect(result.status).toBe('link_required');
		expect(h.directory.users).toHaveLength(1);
		expect(h.store.identities).toEqual([]);
	});

	it('creates one account when two different providers arrive for a new address together', async () => {
		const [a, b] = await Promise.all([
			signInWithProvider(h, 'github', profile({ subject: '1' })),
			signInWithProvider(h, 'google', profile({ subject: '2' }))
		]);
		expect(h.directory.users).toHaveLength(1);
		expect([a.status, b.status].sort()).toEqual(['link_required', 'signed_in']);
		expect(h.store.identities).toHaveLength(1);
	});
});

describe('a provider that only connects', () => {
	it('never starts an account, even for an address no one has', async () => {
		await expectFailure(
			signInWithProvider(h, 'cloudflare', profile({ emailVerified: true })),
			'forbidden'
		);
		expect(h.directory.users).toEqual([]);
		expect(h.store.identities).toEqual([]);
		expect(sessionKeys()).toEqual([]);
	});

	it('names what to do, and never asks for a link by address', async () => {
		await existingUser();
		const error = await expectFailure(
			signInWithProvider(h, 'cloudflare', profile()),
			'forbidden'
		);
		expect(error.message).toContain('connect it from Account');
		expect(error.details).toMatchObject({
			requires: 'connected-account',
			provider: 'cloudflare'
		});
		expect(h.once.keys().filter((name) => name.startsWith('link:'))).toEqual([]);
		expect(h.store.identities).toEqual([]);
	});

	it('signs in the account it was connected to, whatever address it now reports', async () => {
		const owner = await existingUser('owner@example.com');
		await connectIdentity(h, {
			userId: owner.id,
			stepUpAt: clock.now,
			provider: 'cloudflare',
			profile: profile({ email: 'someone@elsewhere.test', emailVerified: false })
		});
		const result = await signInWithProvider(h, 'cloudflare', profile({ email: null }));
		expect(result.status).toBe('signed_in');
		if (result.status !== 'signed_in') return;
		expect(result.user.id).toBe(owner.id);
		expect(result.isNew).toBe(false);
	});
});

describe('connecting from a signed-in session', () => {
	it('adds the identity without an address match and writes an audit row', async () => {
		const owner = await existingUser('owner@example.com');
		const identity = await connectIdentity(h, {
			userId: owner.id,
			stepUpAt: clock.now,
			provider: 'cloudflare',
			profile: profile({ email: 'Other@Elsewhere.test', emailVerified: false })
		});
		expect(identity).toMatchObject({
			userId: owner.id,
			provider: 'cloudflare',
			providerSubject: '4242',
			email: 'other@elsewhere.test',
			verified: false
		});
		expect(h.directory.audits.at(-1)?.input).toEqual({
			actor: owner.id,
			action: 'account.identity.link',
			target: identity.id,
			detail: { provider: 'cloudflare', via: 'session' }
		});
	});

	it('keeps no address when the provider gave none', async () => {
		const owner = await existingUser();
		const identity = await connectIdentity(h, {
			userId: owner.id,
			stepUpAt: clock.now,
			provider: 'cloudflare',
			profile: profile({ email: null, emailVerified: false })
		});
		expect(identity.email).toBeNull();
	});

	it('needs a fresh authentication, and changes nothing without one', async () => {
		const owner = await existingUser();
		for (const stepUpAt of [undefined, clock.now - STEP_UP_WINDOW_MS - 1]) {
			await expectFailure(
				connectIdentity(h, {
					userId: owner.id,
					stepUpAt,
					provider: 'github',
					profile: profile()
				}),
				'forbidden'
			);
		}
		expect(h.store.identities).toEqual([]);
	});

	it('refuses a provider account that is already connected, here or to another account', async () => {
		const first = await existingUser('first@example.com');
		const second = await existingUser('second@example.com');
		await connectIdentity(h, {
			userId: first.id,
			stepUpAt: clock.now,
			provider: 'github',
			profile: profile()
		});
		for (const userId of [first.id, second.id]) {
			await expectFailure(
				connectIdentity(h, {
					userId,
					stepUpAt: clock.now,
					provider: 'github',
					profile: profile()
				}),
				'conflict'
			);
		}
		expect(h.store.identities).toHaveLength(1);
	});

	it('refuses a user that no longer exists', async () => {
		await expectFailure(
			connectIdentity(h, {
				userId: 'usr_gone',
				stepUpAt: clock.now,
				provider: 'github',
				profile: profile()
			}),
			'unauthenticated'
		);
	});

	it('lets one account hold two accounts of the same provider', async () => {
		const owner = await existingUser();
		for (const subject of ['1', '2']) {
			await connectIdentity(h, {
				userId: owner.id,
				stepUpAt: clock.now,
				provider: 'cloudflare',
				profile: profile({ subject, email: null, emailVerified: false })
			});
		}
		expect(await listIdentities(h, owner.id)).toHaveLength(2);
	});
});

describe('provider sign-in and existing accounts', () => {
	it.each(EMAIL_PROVIDERS)(
		'%s never creates an account or claims one for an unverified address',
		async (provider) => {
			const owner = await existingUser();
			const users = h.directory.users.length;
			for (const email of ['ada@example.com', 'new@example.com']) {
				await expectFailure(
					signInWithProvider(h, provider, profile({ email, emailVerified: false })),
					'forbidden'
				);
			}
			expect(h.directory.users).toHaveLength(users);
			expect(h.store.identities).toEqual([]);
			expect(await listIdentities(h, owner.id)).toEqual([]);
			expect(h.once.keys().filter((name) => name.startsWith('link:'))).toEqual([]);
		}
	);

	it.each(EMAIL_PROVIDERS)(
		'%s with the address of an account asks for a link and signs no one in',
		async (provider) => {
			await existingUser();
			const result = await signInWithProvider(h, provider, profile());
			expect(result.status).toBe('link_required');
			expect(h.store.identities).toEqual([]);
			expect(sessionKeys()).toEqual([]);
		}
	);

	it('gives a known identity whose account has no organisation the missing one', async () => {
		const user = await h.directory.createUser('ada@example.com');
		await h.store.createIdentity({
			userId: user.id,
			provider: 'github',
			providerSubject: '4242',
			email: 'ada@example.com',
			verified: true
		});
		const result = await signInWithProvider(h, 'github', profile());
		expect(result.status).toBe('signed_in');
		expect(h.directory.orgs).toHaveLength(1);
		expect(h.directory.members).toHaveLength(1);
		expect(h.directory.audits.map((a) => a.input.action)).toEqual(['account.repair']);
	});

	it('lets exactly one of two parallel confirmations of one pending link go through', async () => {
		const owner = await existingUser();
		const first = await signInWithProvider(h, 'github', profile());
		if (first.status !== 'link_required') throw new Error('expected a link request');
		const results = await Promise.allSettled([
			confirmLink(h, { userId: owner.id, stepUpAt: clock.now, token: first.token }),
			confirmLink(h, { userId: owner.id, stepUpAt: clock.now, token: first.token })
		]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(h.store.identities).toHaveLength(1);
		expect(
			h.directory.audits.filter((a) => a.input.action === 'account.identity.link')
		).toHaveLength(1);
	});
});

describe('link confirmation', () => {
	async function pendingFor(email = 'ada@example.com', provider: OAuthProvider = 'github') {
		const result = await signInWithProvider(h, provider, profile({ email }));
		if (result.status !== 'link_required') throw new Error('expected a link request');
		return result.token;
	}

	it('links the identity once the owner confirms with a fresh authentication', async () => {
		const owner = await existingUser();
		const token = await pendingFor();
		const identity = await confirmLink(h, { userId: owner.id, stepUpAt: clock.now, token });
		expect(identity).toMatchObject({
			userId: owner.id,
			provider: 'github',
			providerSubject: '4242',
			verified: true
		});
		expect(h.directory.audits.at(-1)).toEqual({
			organizationId: h.store.orgOf.get(owner.id),
			input: {
				actor: owner.id,
				action: 'account.identity.link',
				target: identity.id,
				detail: { provider: 'github' }
			}
		});
		const signedIn = await signInWithProvider(h, 'github', profile());
		expect(signedIn).toMatchObject({ status: 'signed_in', isNew: false });
		if (signedIn.status === 'signed_in') expect(signedIn.user.id).toBe(owner.id);
	});

	it('uses a pending link once', async () => {
		const owner = await existingUser();
		const token = await pendingFor();
		await confirmLink(h, { userId: owner.id, stepUpAt: clock.now, token });
		await expectFailure(
			confirmLink(h, { userId: owner.id, stepUpAt: clock.now, token }),
			'not_found'
		);
		expect(h.store.identities).toHaveLength(1);
	});

	it('needs a fresh authentication', async () => {
		const owner = await existingUser();
		const token = await pendingFor();
		const error = await expectFailure(
			confirmLink(h, { userId: owner.id, stepUpAt: undefined, token }),
			'forbidden'
		);
		expect(error.details).toEqual({ requires: 'step-up' });
		expect(h.store.identities).toEqual([]);
	});

	it('refuses a stale authentication and keeps the pending link for a retry', async () => {
		const owner = await existingUser();
		const token = await pendingFor();
		const stepUpAt = clock.now;
		clock.advance(STEP_UP_WINDOW_MS + 1);
		await expectFailure(confirmLink(h, { userId: owner.id, stepUpAt, token }), 'forbidden');
		await expect(
			confirmLink(h, { userId: owner.id, stepUpAt: clock.now, token })
		).resolves.toBeTruthy();
	});

	it('accepts an authentication exactly at the window edge', async () => {
		const owner = await existingUser();
		const token = await pendingFor();
		const stepUpAt = clock.now;
		clock.advance(STEP_UP_WINDOW_MS);
		await expect(confirmLink(h, { userId: owner.id, stepUpAt, token })).resolves.toBeTruthy();
	});

	it('refuses a step-up stamped in the future', () => {
		expect(() => requireFresh(clock.now + 1)).toThrow(ApiError);
	});

	it('refuses when no link is pending', async () => {
		const owner = await existingUser();
		await expectFailure(
			confirmLink(h, { userId: owner.id, stepUpAt: clock.now, token: undefined }),
			'not_found'
		);
		await expectFailure(
			confirmLink(h, { userId: owner.id, stepUpAt: clock.now, token: 'unknown' }),
			'not_found'
		);
	});

	it('expires the pending link', async () => {
		const owner = await existingUser();
		const token = await pendingFor();
		clock.advance(LINK_TTL_MS);
		await expectFailure(
			confirmLink(h, { userId: owner.id, stepUpAt: clock.now, token }),
			'not_found'
		);
	});

	it('refuses a different signed-in account', async () => {
		await existingUser('ada@example.com');
		const other = await existingUser('grace@example.com');
		const token = await pendingFor('ada@example.com');
		await expectFailure(
			confirmLink(h, { userId: other.id, stepUpAt: clock.now, token }),
			'forbidden'
		);
		expect(h.store.identities).toEqual([]);
	});

	it('refuses when the provider account is already linked elsewhere', async () => {
		const owner = await existingUser();
		const token = await pendingFor();
		await h.store.createIdentity({
			userId: 'someone-else',
			provider: 'github',
			providerSubject: '4242',
			email: null,
			verified: true
		});
		await expectFailure(
			confirmLink(h, { userId: owner.id, stepUpAt: clock.now, token }),
			'conflict',
			'This provider account is already linked'
		);
	});

	it('stops before linking when the account has no audit trail', async () => {
		const orphan = await h.directory.createUser('ada@example.com');
		const token = await pendingFor();
		await expectFailure(
			confirmLink(h, { userId: orphan.id, stepUpAt: clock.now, token }),
			'internal'
		);
		expect(h.store.identities).toEqual([]);
	});

	it('does not leak the pending record into the session store', async () => {
		await existingUser();
		await pendingFor();
		expect(sessionKeys()).toEqual([]);
	});
});

describe('unlink', () => {
	async function linked(provider: OAuthProvider = 'github') {
		const owner = await existingUser();
		const identity = await h.store.createIdentity({
			userId: owner.id,
			provider,
			providerSubject: 'x1',
			email: owner.email,
			verified: true
		});
		return { owner, identity };
	}

	it('removes an identity and writes an audit row', async () => {
		const { owner, identity } = await linked();
		await unlinkIdentity(h, { userId: owner.id, identityId: identity.id, stepUpAt: clock.now });
		expect(await listIdentities(h, owner.id)).toEqual([]);
		expect(h.directory.audits.at(-1)?.input).toEqual({
			actor: owner.id,
			action: 'account.identity.unlink',
			target: identity.id,
			detail: { provider: 'github' }
		});
	});

	it('needs a fresh authentication', async () => {
		const { owner, identity } = await linked();
		await expectFailure(
			unlinkIdentity(h, { userId: owner.id, identityId: identity.id, stepUpAt: undefined }),
			'forbidden'
		);
		expect(h.store.identities).toHaveLength(1);
	});

	it('answers not found for an identity that belongs to someone else', async () => {
		const { identity } = await linked();
		const other = await existingUser('grace@example.com');
		await expectFailure(
			unlinkIdentity(h, { userId: other.id, identityId: identity.id, stepUpAt: clock.now }),
			'not_found'
		);
		expect(h.store.identities).toHaveLength(1);
	});

	it('refuses to remove the last sign-in method', async () => {
		h = identityHarness({ emailFloor: false });
		const { owner, identity } = await linked();
		await expectFailure(
			unlinkIdentity(h, { userId: owner.id, identityId: identity.id, stepUpAt: clock.now }),
			'conflict',
			'This is your last sign-in method, so it cannot be removed'
		);
		expect(h.store.identities).toHaveLength(1);
		expect(h.directory.audits).toEqual([]);
	});

	it('allows the removal when a passkey remains', async () => {
		h = identityHarness({ emailFloor: false });
		const { owner, identity } = await linked();
		h.store.passkeys.push(passkeyRecord(owner.id, 'pk-1'));
		await unlinkIdentity(h, { userId: owner.id, identityId: identity.id, stepUpAt: clock.now });
		expect(h.store.identities).toEqual([]);
	});

	it('allows the removal when another identity remains', async () => {
		h = identityHarness({ emailFloor: false });
		const { owner, identity } = await linked();
		await h.store.createIdentity({
			userId: owner.id,
			provider: 'google',
			providerSubject: 'g1',
			email: null,
			verified: true
		});
		await unlinkIdentity(h, { userId: owner.id, identityId: identity.id, stepUpAt: clock.now });
		expect(h.store.identities).toHaveLength(1);
	});

	it('counts the email code as a method by default, so the only identity can go', async () => {
		const { owner, identity } = await linked();
		await unlinkIdentity(h, { userId: owner.id, identityId: identity.id, stepUpAt: clock.now });
		expect(h.store.identities).toEqual([]);
	});

	it('stops before deleting when the account has no audit trail', async () => {
		const orphan = await h.directory.createUser('ada@example.com');
		const identity = await h.store.createIdentity({
			userId: orphan.id,
			provider: 'github',
			providerSubject: 'x1',
			email: null,
			verified: true
		});
		await expectFailure(
			unlinkIdentity(h, { userId: orphan.id, identityId: identity.id, stepUpAt: clock.now }),
			'internal'
		);
		expect(h.store.identities).toHaveLength(1);
	});
});

function passkeyRecord(userId: string, id: string) {
	return {
		id,
		userId,
		publicKey: 'AAAA',
		counter: 0,
		transports: [],
		deviceType: 'multiDevice' as const,
		backedUp: true,
		name: 'Laptop',
		createdAt: clock.now,
		lastUsedAt: null
	};
}

describe('passkey management', () => {
	let key: Authenticator;
	let userId: string;

	beforeEach(async () => {
		key = await makeAuthenticator(h.webauthn);
		userId = (await existingUser()).id;
	});

	async function addPasskey(over: { stepUpAt?: number | undefined; name?: string } = {}) {
		const options = await startPasskeyRegistration(h, { userId, stepUpAt: clock.now });
		return finishPasskeyRegistration(h, {
			userId,
			stepUpAt: 'stepUpAt' in over ? over.stepUpAt : clock.now,
			response: await key.register(options),
			name: over.name
		});
	}

	it('registers a passkey and writes an audit row', async () => {
		const passkey = await addPasskey({ name: 'Work laptop' });
		expect(passkey.name).toBe('Work laptop');
		expect(h.directory.audits.at(-1)).toEqual({
			organizationId: h.store.orgOf.get(userId),
			input: { actor: userId, action: 'account.passkey.add', target: passkey.id }
		});
	});

	it('needs a fresh authentication for both steps', async () => {
		await expectFailure(
			startPasskeyRegistration(h, { userId, stepUpAt: undefined }),
			'forbidden'
		);
		const options = await startPasskeyRegistration(h, { userId, stepUpAt: clock.now });
		await expectFailure(
			finishPasskeyRegistration(h, {
				userId,
				stepUpAt: undefined,
				response: await key.register(options)
			}),
			'forbidden'
		);
		expect(h.store.passkeys).toEqual([]);
	});

	it('writes no audit row and stores nothing when the credential is refused', async () => {
		const options = await startPasskeyRegistration(h, { userId, stepUpAt: clock.now });
		await expectFailure(
			finishPasskeyRegistration(h, {
				userId,
				stepUpAt: clock.now,
				response: await key.register(options, { origin: 'https://evil.example.com' })
			}),
			'validation'
		);
		expect(h.store.passkeys).toEqual([]);
		expect(h.directory.audits).toEqual([]);
	});

	it('renames a passkey with an audit row, and answers not found for a stranger', async () => {
		const passkey = await addPasskey();
		await renamePasskey(h, { userId, passkeyId: passkey.id, name: '  Phone ' });
		expect(h.store.passkeys[0]?.name).toBe('Phone');
		expect(h.directory.audits.at(-1)?.input.action).toBe('account.passkey.rename');
		const other = await existingUser('grace@example.com');
		await expectFailure(
			renamePasskey(h, { userId: other.id, passkeyId: passkey.id, name: 'x' }),
			'not_found'
		);
		expect(h.store.passkeys[0]?.name).toBe('Phone');
	});

	it('removes a passkey with an audit row when the email code remains', async () => {
		const passkey = await addPasskey();
		await removePasskey(h, { userId, passkeyId: passkey.id, stepUpAt: clock.now });
		expect(h.store.passkeys).toEqual([]);
		expect(h.directory.audits.at(-1)?.input).toEqual({
			actor: userId,
			action: 'account.passkey.remove',
			target: passkey.id
		});
	});

	it('needs a fresh authentication to remove one', async () => {
		const passkey = await addPasskey();
		await expectFailure(
			removePasskey(h, { userId, passkeyId: passkey.id, stepUpAt: undefined }),
			'forbidden'
		);
		expect(h.store.passkeys).toHaveLength(1);
	});

	it('refuses to remove the last sign-in method', async () => {
		h = identityHarness({ emailFloor: false });
		userId = (await existingUser('lin@example.com')).id;
		const passkey = await addPasskey();
		await expectFailure(
			removePasskey(h, { userId, passkeyId: passkey.id, stepUpAt: clock.now }),
			'conflict',
			'This is your last sign-in method, so it cannot be removed'
		);
		expect(h.store.passkeys).toHaveLength(1);
	});

	it('removes one of two passkeys even without the email floor', async () => {
		h = identityHarness({ emailFloor: false });
		userId = (await existingUser('lin@example.com')).id;
		const first = await addPasskey();
		key = await makeAuthenticator(h.webauthn);
		await addPasskey();
		await removePasskey(h, { userId, passkeyId: first.id, stepUpAt: clock.now });
		expect(h.store.passkeys).toHaveLength(1);
	});

	it("answers not found for another user's passkey", async () => {
		const passkey = await addPasskey();
		const other = await existingUser('grace@example.com');
		await expectFailure(
			removePasskey(h, { userId: other.id, passkeyId: passkey.id, stepUpAt: clock.now }),
			'not_found'
		);
	});

	it('signs in with a passkey and opens a session', async () => {
		await addPasskey();
		const options = await authenticationOptions({ once: h.once, config: h.webauthn });
		const result = await signInWithPasskey(h, await key.assert(options, userId), {
			userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0'
		});
		expect(result).toMatchObject({ status: 'signed_in', isNew: false });
		expect(result.user.id).toBe(userId);
		expect((await getSession(h.kv, result.token))?.device).toBe('Chrome on macOS');
		expect(sessionKeys().length).toBeGreaterThan(0);
	});

	it('opens no session when the passkey is refused', async () => {
		await addPasskey();
		const options = await authenticationOptions({ once: h.once, config: h.webauthn });
		await expectFailure(
			signInWithPasskey(h, await key.assert(options, userId, { counter: 0, flags: 0x01 })),
			'unauthenticated'
		);
		expect(sessionKeys()).toEqual([]);
	});

	it('refuses a passkey whose user no longer exists', async () => {
		await addPasskey();
		h.directory.users.length = 0;
		const options = await authenticationOptions({ once: h.once, config: h.webauthn });
		await expectFailure(
			signInWithPasskey(h, await key.assert(options, userId)),
			'unauthenticated'
		);
	});
});

describe('wrapper calls', () => {
	it('lists identities through the store', async () => {
		const owner = await existingUser();
		expect(await listIdentities(h, owner.id)).toEqual([]);
	});

	it('builds registration options for a user', async () => {
		const options = await registrationOptions(
			{ once: h.once, store: h.store, config: h.webauthn },
			{ id: 'user-1', email: 'ada@example.com' }
		);
		expect(options.user.id.length).toBeGreaterThan(0);
	});
});
