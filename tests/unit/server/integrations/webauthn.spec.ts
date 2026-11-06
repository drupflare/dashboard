import { toBase64Url } from '@contracts/common';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	CHALLENGE_TTL_MS,
	authenticationOptions,
	cleanPasskeyName,
	registrationOptions,
	verifyAuthentication,
	verifyRegistration,
	type WebAuthnDeps
} from '../../../../src/server/integrations/webauthn';
import { ApiError } from '../../../../src/shared/errors';
import { memoryOnce, useClock } from '../services/auth-support';
import { RP, memoryStore, type MemoryStore } from '../services/identities-support';
import { makeAuthenticator, newKeyPair, type Authenticator } from './webauthn-support';

const USER = { id: 'user-1', email: 'ada@example.com' };

let clock: ReturnType<typeof useClock>;
let store: MemoryStore;
let deps: WebAuthnDeps;
let key: Authenticator;

beforeEach(async () => {
	clock = useClock();
	store = memoryStore();
	deps = { once: memoryOnce(), store, config: RP };
	key = await makeAuthenticator(RP);
});

afterEach(() => clock.stop());

async function register(name?: string) {
	const options = await registrationOptions(deps, USER);
	return verifyRegistration(deps, USER, await key.register(options), name);
}

async function signInOptions() {
	return authenticationOptions(deps);
}

async function expectFailure(run: Promise<unknown>, code: string, message?: string) {
	const error = await run.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(ApiError);
	expect((error as ApiError).code).toBe(code);
	if (message) expect((error as ApiError).message).toBe(message);
}

describe('registration', () => {
	it('asks for a resident, user-verified key and names the relying party', async () => {
		const options = await registrationOptions(deps, USER);
		expect(options.rp).toEqual({ name: 'Drupflare', id: 'dash.example.com' });
		expect(options.user.name).toBe(USER.email);
		expect(options.authenticatorSelection).toMatchObject({
			residentKey: 'required',
			userVerification: 'required'
		});
		expect(options.attestation).toBe('none');
		expect(options.challenge.length).toBeGreaterThanOrEqual(43);
	});

	it('stores the key, the counter and a default name', async () => {
		const passkey = await register();
		expect(passkey).toMatchObject({
			id: key.credentialId,
			userId: USER.id,
			counter: 0,
			name: 'Passkey',
			lastUsedAt: null
		});
		expect(store.passkeys).toHaveLength(1);
		expect(passkey.publicKey.length).toBeGreaterThan(40);
	});

	it('lists registered keys as excluded credentials on the next call', async () => {
		await register();
		const options = await registrationOptions(deps, USER);
		expect(options.excludeCredentials?.map((c) => c.id)).toEqual([key.credentialId]);
	});

	it('accepts a challenge once', async () => {
		const options = await registrationOptions(deps, USER);
		const response = await key.register(options);
		await verifyRegistration(deps, USER, response, undefined);
		await expectFailure(
			verifyRegistration(deps, USER, response, undefined),
			'validation',
			'The passkey could not be verified'
		);
	});

	it('refuses a response when no challenge was issued', async () => {
		const response = await key.register({ challenge: 'AAAA' });
		await expectFailure(verifyRegistration(deps, USER, response, undefined), 'validation');
	});

	it('refuses a challenge for another user', async () => {
		const options = await registrationOptions(deps, USER);
		const response = await key.register(options);
		await expectFailure(
			verifyRegistration(deps, { id: 'user-2' }, response, undefined),
			'validation'
		);
	});

	it('expires the challenge at five minutes', async () => {
		const options = await registrationOptions(deps, USER);
		const response = await key.register(options);
		clock.advance(CHALLENGE_TTL_MS);
		await expectFailure(verifyRegistration(deps, USER, response, undefined), 'validation');
	});

	it('still accepts it one millisecond before expiry', async () => {
		const options = await registrationOptions(deps, USER);
		const response = await key.register(options);
		clock.advance(CHALLENGE_TTL_MS - 1);
		await expect(verifyRegistration(deps, USER, response, undefined)).resolves.toBeTruthy();
	});

	it.each([
		['a wrong origin', { origin: 'https://evil.example.com' }],
		['a wrong relying party', { rpId: 'evil.example.com' }],
		['a wrong challenge', { challenge: 'AAAAAAAAAAAAAAAAAAAAAA' }],
		['a wrong type', { type: 'webauthn.get' }],
		['no user verification', { flags: 0x41 }],
		['no user presence', { flags: 0x44 }]
	])('refuses %s', async (_, over) => {
		const options = await registrationOptions(deps, USER);
		const response = await key.register(options, over);
		await expectFailure(
			verifyRegistration(deps, USER, response, undefined),
			'validation',
			'The passkey could not be verified'
		);
		expect(store.passkeys).toHaveLength(0);
	});

	it('refuses to register the same credential twice', async () => {
		await register();
		await expectFailure(register(), 'conflict', 'This passkey is already registered');
		expect(store.passkeys).toHaveLength(1);
	});

	it('cleans the name', () => {
		expect(cleanPasskeyName(undefined)).toBe('Passkey');
		expect(cleanPasskeyName('   ')).toBe('Passkey');
		expect(cleanPasskeyName('  My   laptop ')).toBe('My laptop');
		expect(cleanPasskeyName('x'.repeat(200))).toHaveLength(64);
	});

	it('keeps the chosen name', async () => {
		expect((await register('Work laptop')).name).toBe('Work laptop');
	});
});

describe('authentication', () => {
	beforeEach(async () => {
		await register();
	});

	it('asks for user verification and sets no allow list', async () => {
		const options = await signInOptions();
		expect(options.rpId).toBe('dash.example.com');
		expect(options.userVerification).toBe('required');
		expect(options.allowCredentials ?? []).toEqual([]);
	});

	it('signs in with a signed challenge and advances the counter', async () => {
		const options = await signInOptions();
		const passkey = await verifyAuthentication(deps, await key.assert(options, USER.id));
		expect(passkey.userId).toBe(USER.id);
		expect(passkey.counter).toBe(1);
		expect(store.passkeys[0]).toMatchObject({ counter: 1, lastUsedAt: clock.now });
	});

	it('works across several sign-ins with a rising counter', async () => {
		for (let round = 1; round <= 3; round++) {
			const options = await signInOptions();
			await verifyAuthentication(deps, await key.assert(options, USER.id));
			expect(store.passkeys[0]?.counter).toBe(round);
		}
	});

	it('accepts a counter that stays at zero, as synced passkeys report it', async () => {
		const options = await signInOptions();
		await expect(
			verifyAuthentication(deps, await key.assert(options, USER.id, { counter: 0 }))
		).resolves.toMatchObject({ counter: 0 });
	});

	it('refuses a replayed challenge', async () => {
		const options = await signInOptions();
		const first = await key.assert(options, USER.id);
		await verifyAuthentication(deps, first);
		const replay = await key.assert(options, USER.id);
		await expectFailure(
			verifyAuthentication(deps, replay),
			'unauthenticated',
			'The passkey could not be verified'
		);
	});

	it('refuses a challenge the server never issued', async () => {
		const forged = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
		await expectFailure(
			verifyAuthentication(deps, await key.assert({ challenge: forged }, USER.id)),
			'unauthenticated'
		);
	});

	it('expires the challenge at five minutes', async () => {
		const options = await signInOptions();
		const response = await key.assert(options, USER.id);
		clock.advance(CHALLENGE_TTL_MS);
		await expectFailure(verifyAuthentication(deps, response), 'unauthenticated');
	});

	it('refuses a wrong origin', async () => {
		const options = await signInOptions();
		await expectFailure(
			verifyAuthentication(
				deps,
				await key.assert(options, USER.id, { origin: 'https://evil.example.com' })
			),
			'unauthenticated'
		);
		expect(store.passkeys[0]?.counter).toBe(0);
	});

	it('refuses a wrong relying party', async () => {
		const options = await signInOptions();
		await expectFailure(
			verifyAuthentication(
				deps,
				await key.assert(options, USER.id, { rpId: 'evil.example.com' })
			),
			'unauthenticated'
		);
	});

	it('refuses a counter that goes backwards', async () => {
		for (const counter of [1, 2, 3]) {
			const options = await signInOptions();
			await verifyAuthentication(deps, await key.assert(options, USER.id, { counter }));
		}
		const options = await signInOptions();
		await expectFailure(
			verifyAuthentication(deps, await key.assert(options, USER.id, { counter: 2 })),
			'unauthenticated'
		);
		expect(store.passkeys[0]?.counter).toBe(3);
	});

	it('refuses a counter that does not move', async () => {
		const options = await signInOptions();
		await verifyAuthentication(deps, await key.assert(options, USER.id, { counter: 5 }));
		const next = await signInOptions();
		await expectFailure(
			verifyAuthentication(deps, await key.assert(next, USER.id, { counter: 5 })),
			'unauthenticated'
		);
	});

	it('refuses a signature from another key', async () => {
		const options = await signInOptions();
		const other = await newKeyPair();
		await expectFailure(
			verifyAuthentication(
				deps,
				await key.assert(options, USER.id, { signWith: other.privateKey })
			),
			'unauthenticated'
		);
	});

	it('refuses an assertion without user verification', async () => {
		const options = await signInOptions();
		await expectFailure(
			verifyAuthentication(deps, await key.assert(options, USER.id, { flags: 0x01 })),
			'unauthenticated'
		);
	});

	it('refuses a user handle that names another user', async () => {
		const options = await signInOptions();
		await expectFailure(
			verifyAuthentication(deps, await key.assert(options, 'user-2')),
			'unauthenticated'
		);
	});

	it('accepts an assertion that carries no user handle', async () => {
		const options = await signInOptions();
		await expect(
			verifyAuthentication(deps, await key.assert(options, USER.id, { userHandle: null }))
		).resolves.toMatchObject({ userId: USER.id });
	});

	it('refuses an unknown credential with the same error', async () => {
		const options = await signInOptions();
		const stranger = await makeAuthenticator(RP);
		await expectFailure(
			verifyAuthentication(deps, await stranger.assert(options, USER.id)),
			'unauthenticated',
			'The passkey could not be verified'
		);
	});

	it('loses a counter race: the compare-and-set refuses the second writer', async () => {
		const options = await signInOptions();
		const response = await key.assert(options, USER.id);
		const seen = store.advancePasskeyCounter.bind(store);
		store.advancePasskeyCounter = async (id, from, to, usedAt) => {
			await seen(id, from, to, usedAt);
			return false;
		};
		await expectFailure(verifyAuthentication(deps, response), 'unauthenticated');
	});

	it('keeps no challenge in the store after use', async () => {
		const options = await signInOptions();
		await verifyAuthentication(deps, await key.assert(options, USER.id));
		const once = deps.once as ReturnType<typeof memoryOnce>;
		expect(once.keys().filter((name) => name.startsWith('webauthn:auth:'))).toEqual([]);
	});

	it('stores the challenge under a hash, expiring with the challenge life', async () => {
		const once = deps.once as ReturnType<typeof memoryOnce>;
		const options = await signInOptions();
		const names = once.keys().filter((name) => name.startsWith('webauthn:auth:'));
		expect(names).toHaveLength(1);
		expect(names[0]).not.toContain(options.challenge);
		expect(once.puts.at(-1)?.expiresAt).toBe(clock.now + CHALLENGE_TTL_MS);
	});
});

describe('worker startup', () => {
	it('loads the reflect polyfill before the library that needs it', () => {
		const source = readFileSync(
			new URL('../../../../src/server/integrations/webauthn.ts', import.meta.url),
			'utf8'
		);
		const polyfill = source.indexOf("import 'reflect-metadata'");
		expect(polyfill).toBeGreaterThanOrEqual(0);
		expect(polyfill).toBeLessThan(source.indexOf("from '@simplewebauthn/server'"));
	});

	it('keeps the polyfill in the bundle, which drops side-effect imports from packages by default', () => {
		const config = readFileSync(new URL('../../../../nuxt.config.ts', import.meta.url), 'utf8');
		expect(config).toContain("moduleSideEffects: ['reflect-metadata']");
	});
});
