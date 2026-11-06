import { sha256Hex } from '@contracts/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	OAUTH_CONSENT_TEXT,
	OAUTH_PROVIDERS,
	OAUTH_SCOPES,
	OAUTH_STATE_TTL_MS,
	beginOAuth,
	completeOAuth,
	edovVerified,
	isOAuthProvider,
	oauthClient,
	oauthClients,
	type OAuthDeps,
	type OAuthProvider,
	type ProviderProfile
} from '../../../../src/server/integrations/oauth';
import { ApiError } from '../../../../src/shared/errors';
import { memoryOnce, useClock, type MemoryOnce } from '../services/auth-support';
import {
	CREDS,
	PROFILE_URLS,
	fakeFetch,
	idToken,
	primeProfile,
	type FakeFetch
} from '../services/identities-support';

let clock: ReturnType<typeof useClock>;
let once: MemoryOnce;
let net: FakeFetch;
let tokens: Record<string, ReturnType<typeof primeProfile>>;
let deps: OAuthDeps;

const PROFILE = { subject: '4242', email: 'Ada@Example.com', emailVerified: true, name: 'Ada' };

beforeEach(() => {
	clock = useClock();
	once = memoryOnce();
	net = fakeFetch();
	tokens = {};
	const clients = oauthClients(
		Object.fromEntries(OAUTH_PROVIDERS.map((p) => [p, CREDS(p)])) as never
	);
	for (const provider of OAUTH_PROVIDERS) {
		const real = clients[provider]!;
		clients[provider] = {
			...real,
			exchange: async () => {
				const issued = tokens[provider];
				if (!issued) throw new Error('refused');
				return issued;
			}
		};
	}
	deps = { once, clients, fetch: net.fn };
});

afterEach(() => {
	clock.stop();
	vi.unstubAllGlobals();
});

async function begin(provider: OAuthProvider) {
	const started = await beginOAuth(deps, provider);
	return { ...started, cookieState: started.state };
}

async function expectFailure(run: Promise<unknown>, code: string) {
	const error = await run.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(ApiError);
	expect((error as ApiError).code).toBe(code);
	return error as ApiError;
}

describe('start url', () => {
	it.each(OAUTH_PROVIDERS)(
		'%s carries state, a PKCE challenge and the minimal scopes',
		async (provider) => {
			const { url, state } = await beginOAuth(deps, provider);
			const params = new URL(url).searchParams;
			expect(params.get('response_type')).toBe('code');
			expect(params.get('client_id')).toBe(CREDS(provider).clientId);
			expect(params.get('redirect_uri')).toBe(CREDS(provider).redirectUri);
			expect(params.get('state')).toBe(state);
			expect(params.get('code_challenge_method')).toBe('S256');
			expect(params.get('scope')?.split(' ')).toEqual([...OAUTH_SCOPES[provider]]);
		}
	);

	it.each(OAUTH_PROVIDERS)(
		'%s challenge is the S256 hash of the stored verifier',
		async (provider) => {
			const { url, state } = await beginOAuth(deps, provider);
			const record = JSON.parse(
				once.dump()[`oauth:state:${await sha256Hex(state)}`] as string
			);
			const digest = await crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode(record.verifier)
			);
			const challenge = Buffer.from(digest).toString('base64url');
			expect(new URL(url).searchParams.get('code_challenge')).toBe(challenge);
			expect(url).not.toContain(record.verifier);
		}
	);

	it.each(OAUTH_PROVIDERS)('%s asks for no repository or write scope', (provider) => {
		for (const scope of OAUTH_SCOPES[provider]) {
			expect(scope).not.toMatch(/repo|write|admin|api|workflow/);
		}
	});

	it('starts each provider at its own authorization host', async () => {
		const hosts = await Promise.all(
			OAUTH_PROVIDERS.map(async (p) => new URL((await beginOAuth(deps, p)).url).host)
		);
		expect(hosts).toEqual([
			'github.com',
			'gitlab.com',
			'accounts.google.com',
			'login.microsoftonline.com'
		]);
	});

	it('follows a self-hosted GitLab base url and a Microsoft tenant', () => {
		const gitlab = oauthClient('gitlab', {
			...CREDS('gitlab'),
			baseUrl: 'https://git.example.edu/'
		});
		expect(gitlab.authorizationUrl('s', 'v').origin).toBe('https://git.example.edu');
		const microsoft = oauthClient('microsoft', { ...CREDS('microsoft'), tenant: 'contoso' });
		expect(microsoft.authorizationUrl('s', 'v').pathname).toBe(
			'/contoso/oauth2/v2.0/authorize'
		);
	});

	it('uses a fresh state and verifier each time, kept only as a hash', async () => {
		const a = await beginOAuth(deps, 'github');
		const b = await beginOAuth(deps, 'github');
		expect(a.state).not.toBe(b.state);
		expect(a.state.length).toBeGreaterThanOrEqual(43);
		for (const name of once.keys()) expect(name).not.toContain(a.state);
		expect(once.puts.every((put) => put.expiresAt === clock.now + OAUTH_STATE_TTL_MS)).toBe(
			true
		);
	});

	it('says why before the handoff', () => {
		expect(OAUTH_CONSENT_TEXT).toContain('name and email');
		expect(OAUTH_CONSENT_TEXT).toContain('does not read your repositories');
	});

	it('refuses a provider with no client', async () => {
		const error = await expectFailure(
			beginOAuth({ ...deps, clients: {} }, 'github'),
			'not_built'
		);
		expect(error.message).toContain('not configured');
	});

	it('recognises the four providers only', () => {
		expect(OAUTH_PROVIDERS.every(isOAuthProvider)).toBe(true);
		expect(isOAuthProvider('facebook')).toBe(false);
		expect(isOAuthProvider(undefined)).toBe(false);
	});
});

describe('callback', () => {
	it.each(OAUTH_PROVIDERS)('%s returns the provider profile', async (provider) => {
		tokens[provider] = primeProfile(net, provider, PROFILE);
		const { state, cookieState } = await begin(provider);
		const profile = await completeOAuth(deps, provider, { code: 'c', state, cookieState });
		expect(profile).toEqual({
			subject: '4242',
			email: 'Ada@Example.com',
			emailVerified: true,
			name: 'Ada'
		});
	});

	it('hands the stored verifier to the code exchange', async () => {
		const seen: string[] = [];
		deps.clients.github = {
			...deps.clients.github!,
			exchange: async (_code, verifier) => {
				seen.push(verifier);
				return primeProfile(net, 'github', PROFILE);
			}
		};
		const { url, state, cookieState } = await begin('github');
		await completeOAuth(deps, 'github', { code: 'c', state, cookieState });
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seen[0]));
		expect(new URL(url).searchParams.get('code_challenge')).toBe(
			Buffer.from(digest).toString('base64url')
		);
	});

	it('sends the access token to the profile endpoints', async () => {
		tokens.github = primeProfile(net, 'github', PROFILE);
		const { state, cookieState } = await begin('github');
		await completeOAuth(deps, 'github', { code: 'c', state, cookieState });
		expect(net.calls).toEqual([
			{ url: PROFILE_URLS.githubUser, authorization: 'Bearer gh-token' },
			{ url: PROFILE_URLS.githubEmails, authorization: 'Bearer gh-token' }
		]);
	});

	it('refuses a state that does not match the cookie', async () => {
		tokens.github = primeProfile(net, 'github', PROFILE);
		const { state } = await begin('github');
		await expectFailure(
			completeOAuth(deps, 'github', { code: 'c', state, cookieState: 'another-browser' }),
			'unauthenticated'
		);
		expect(net.calls).toEqual([]);
	});

	it('refuses a callback with no cookie', async () => {
		tokens.github = primeProfile(net, 'github', PROFILE);
		const { state } = await begin('github');
		await expectFailure(completeOAuth(deps, 'github', { code: 'c', state }), 'unauthenticated');
	});

	it('refuses a callback with no state', async () => {
		await expectFailure(
			completeOAuth(deps, 'github', { code: 'c', cookieState: 'x' }),
			'unauthenticated'
		);
	});

	it('refuses a state the server never issued, even with a matching cookie', async () => {
		await expectFailure(
			completeOAuth(deps, 'github', { code: 'c', state: 'forged', cookieState: 'forged' }),
			'unauthenticated'
		);
	});

	it('refuses a replayed state', async () => {
		tokens.github = primeProfile(net, 'github', PROFILE);
		const { state, cookieState } = await begin('github');
		await completeOAuth(deps, 'github', { code: 'c', state, cookieState });
		await expectFailure(
			completeOAuth(deps, 'github', { code: 'c', state, cookieState }),
			'unauthenticated'
		);
	});

	it('refuses a state started for another provider', async () => {
		tokens.google = primeProfile(net, 'google', PROFILE);
		const { state, cookieState } = await begin('github');
		await expectFailure(
			completeOAuth(deps, 'google', { code: 'c', state, cookieState }),
			'unauthenticated'
		);
	});

	it('expires the state at ten minutes', async () => {
		tokens.github = primeProfile(net, 'github', PROFILE);
		const { state, cookieState } = await begin('github');
		clock.advance(OAUTH_STATE_TTL_MS);
		await expectFailure(
			completeOAuth(deps, 'github', { code: 'c', state, cookieState }),
			'unauthenticated'
		);
	});

	it('works one millisecond before the state expires', async () => {
		tokens.github = primeProfile(net, 'github', PROFILE);
		const { state, cookieState } = await begin('github');
		clock.advance(OAUTH_STATE_TTL_MS - 1);
		await expect(
			completeOAuth(deps, 'github', { code: 'c', state, cookieState })
		).resolves.toBeTruthy();
	});

	it('answers a missing code with a validation error, and burns the state', async () => {
		tokens.github = primeProfile(net, 'github', PROFILE);
		const { state, cookieState } = await begin('github');
		await expectFailure(completeOAuth(deps, 'github', { state, cookieState }), 'validation');
		await expectFailure(
			completeOAuth(deps, 'github', { code: 'c', state, cookieState }),
			'unauthenticated'
		);
	});

	it('refuses a provider error and burns the state', async () => {
		tokens.github = primeProfile(net, 'github', PROFILE);
		const { state, cookieState } = await begin('github');
		await expectFailure(
			completeOAuth(deps, 'github', { error: 'access_denied', state, cookieState }),
			'unauthenticated'
		);
		await expectFailure(
			completeOAuth(deps, 'github', { code: 'c', state, cookieState }),
			'unauthenticated'
		);
	});

	it('hides a failed code exchange behind the same error', async () => {
		const { state, cookieState } = await begin('github');
		const error = await expectFailure(
			completeOAuth(deps, 'github', { code: 'bad', state, cookieState }),
			'unauthenticated'
		);
		expect(error.message).toBe('The sign-in could not be completed');
	});

	it('refuses a profile fetch that fails', async () => {
		tokens.google = { accessToken: 'g', idToken: null };
		const { state, cookieState } = await begin('google');
		await expectFailure(
			completeOAuth(deps, 'google', { code: 'c', state, cookieState }),
			'unauthenticated'
		);
	});

	it('refuses a profile body of the wrong shape', async () => {
		tokens.google = { accessToken: 'g', idToken: null };
		net.replies.set(PROFILE_URLS.google, { body: { email: 'a@b.c' } });
		const { state, cookieState } = await begin('google');
		await expectFailure(
			completeOAuth(deps, 'google', { code: 'c', state, cookieState }),
			'unauthenticated'
		);
	});
});

describe('email verification by provider', () => {
	async function run(provider: OAuthProvider, profile: ProviderProfile) {
		tokens[provider] = primeProfile(net, provider, profile);
		const { state, cookieState } = await begin(provider);
		return completeOAuth(deps, provider, { code: 'c', state, cookieState });
	}

	it.each(OAUTH_PROVIDERS)('%s reports an unverified email as unverified', async (provider) => {
		const profile = await run(provider, { ...PROFILE, emailVerified: false });
		expect(profile.emailVerified).toBe(false);
		expect(profile.email).toBe('Ada@Example.com');
	});

	it.each(OAUTH_PROVIDERS)('%s reports no email as null', async (provider) => {
		const profile = await run(provider, { ...PROFILE, email: null, emailVerified: false });
		expect(profile.email).toBeNull();
		expect(profile.emailVerified).toBe(false);
	});

	it('GitHub gives no address when none is primary, even if another is verified', async () => {
		tokens.github = { accessToken: 'gh-token', idToken: null };
		net.replies.set(PROFILE_URLS.githubUser, { body: { id: 7, name: null } });
		net.replies.set(PROFILE_URLS.githubEmails, {
			body: [
				{ email: 'old@example.com', primary: false, verified: false },
				{ email: 'ok@example.com', primary: false, verified: true }
			]
		});
		const { state, cookieState } = await begin('github');
		const profile = await completeOAuth(deps, 'github', { code: 'c', state, cookieState });
		expect(profile).toMatchObject({ subject: '7', email: null, emailVerified: false });
	});

	it('GitHub trusts a verified primary address', async () => {
		tokens.github = { accessToken: 'gh-token', idToken: null, scopes: ['user:email'] };
		net.replies.set(PROFILE_URLS.githubUser, { body: { id: 7 } });
		net.replies.set(PROFILE_URLS.githubEmails, {
			body: [{ email: 'main@example.com', primary: true, verified: true }]
		});
		const { state, cookieState } = await begin('github');
		const profile = await completeOAuth(deps, 'github', { code: 'c', state, cookieState });
		expect(profile).toMatchObject({ email: 'main@example.com', emailVerified: true });
	});

	it('GitHub refuses a token that was not granted the email scope, and asks for no emails', async () => {
		tokens.github = { accessToken: 'gh-token', idToken: null, scopes: ['read:user'] };
		const { state, cookieState } = await begin('github');
		await expectFailure(
			completeOAuth(deps, 'github', { code: 'c', state, cookieState }),
			'unauthenticated'
		);
		expect(net.calls.some((call) => call.url === PROFILE_URLS.githubEmails)).toBe(false);
	});

	it.each([
		[true, true],
		['1', true],
		['true', true],
		[false, false],
		['0', false],
		['false', false],
		[undefined, false],
		[null, false]
	])('Microsoft reads the domain-owner claim %j as %s', (claim, verified) => {
		expect(edovVerified(claim)).toBe(verified);
	});

	it('GitHub prefers the primary address even when it is unverified', async () => {
		tokens.github = { accessToken: 'gh-token', idToken: null };
		net.replies.set(PROFILE_URLS.githubUser, { body: { id: 7 } });
		net.replies.set(PROFILE_URLS.githubEmails, {
			body: [
				{ email: 'other@example.com', primary: false, verified: true },
				{ email: 'main@example.com', primary: true, verified: false }
			]
		});
		const { state, cookieState } = await begin('github');
		const profile = await completeOAuth(deps, 'github', { code: 'c', state, cookieState });
		expect(profile).toMatchObject({ email: 'main@example.com', emailVerified: false });
	});

	it('Microsoft trusts the email only with the domain-owner claim', async () => {
		const claims = { sub: 'm1', aud: CREDS('microsoft').clientId, email: 'ada@example.com' };
		tokens.microsoft = { accessToken: 'm', idToken: idToken(claims) };
		let begun = await begin('microsoft');
		let profile = await completeOAuth(deps, 'microsoft', {
			code: 'c',
			state: begun.state,
			cookieState: begun.cookieState
		});
		expect(profile.emailVerified).toBe(false);
		tokens.microsoft = { accessToken: 'm', idToken: idToken({ ...claims, xms_edov: true }) };
		begun = await begin('microsoft');
		profile = await completeOAuth(deps, 'microsoft', {
			code: 'c',
			state: begun.state,
			cookieState: begun.cookieState
		});
		expect(profile.emailVerified).toBe(true);
	});

	it('Microsoft refuses an id token issued to another client', async () => {
		tokens.microsoft = {
			accessToken: 'm',
			idToken: idToken({ sub: 'm1', aud: 'someone-else', email: 'a@b.c', xms_edov: true })
		};
		const { state, cookieState } = await begin('microsoft');
		await expectFailure(
			completeOAuth(deps, 'microsoft', { code: 'c', state, cookieState }),
			'unauthenticated'
		);
	});

	it('Microsoft refuses a response with no id token', async () => {
		tokens.microsoft = { accessToken: 'm', idToken: null };
		const { state, cookieState } = await begin('microsoft');
		await expectFailure(
			completeOAuth(deps, 'microsoft', { code: 'c', state, cookieState }),
			'unauthenticated'
		);
	});
});

describe('real code exchange', () => {
	function stubToken(body: unknown) {
		const seen: { url: string; body: string; authorization: string | null }[] = [];
		vi.stubGlobal('fetch', async (input: Request) => {
			seen.push({
				url: input.url,
				body: await input.text(),
				authorization: input.headers.get('authorization')
			});
			return new Response(JSON.stringify(body), { status: 200 });
		});
		return seen;
	}

	it('GitHub posts the code and the verifier to the token endpoint', async () => {
		const seen = stubToken({ access_token: 'at', token_type: 'bearer' });
		const tokensBack = await oauthClient('github', CREDS('github')).exchange(
			'the-code',
			'the-verifier'
		);
		expect(tokensBack).toEqual({ accessToken: 'at', idToken: null });
		expect(seen[0]?.url).toBe('https://github.com/login/oauth/access_token');
		const form = new URLSearchParams(seen[0]?.body);
		expect(form.get('grant_type')).toBe('authorization_code');
		expect(form.get('code')).toBe('the-code');
		expect(form.get('code_verifier')).toBe('the-verifier');
		expect(seen[0]?.authorization).toMatch(/^Basic /);
	});

	it('reads the granted scopes whether the provider separates them by commas or spaces', async () => {
		stubToken({ access_token: 'at', token_type: 'bearer', scope: 'read:user,user:email' });
		const github = await oauthClient('github', CREDS('github')).exchange('c', 'v');
		expect(github.scopes).toEqual(['read:user', 'user:email']);
		stubToken({ access_token: 'at', token_type: 'Bearer', scope: 'openid email profile' });
		const google = await oauthClient('google', CREDS('google')).exchange('c', 'v');
		expect(google.scopes).toEqual(['openid', 'email', 'profile']);
	});

	it('Google returns the id token when the provider sends one', async () => {
		const seen = stubToken({ access_token: 'at', token_type: 'Bearer', id_token: 'a.b.c' });
		const back = await oauthClient('google', CREDS('google')).exchange('c', 'v');
		expect(back).toEqual({ accessToken: 'at', idToken: 'a.b.c' });
		expect(seen[0]?.url).toBe('https://oauth2.googleapis.com/token');
		expect(new URLSearchParams(seen[0]?.body).get('code_verifier')).toBe('v');
	});

	it('GitLab and Microsoft use their own token endpoints', async () => {
		const seen = stubToken({ access_token: 'at', token_type: 'Bearer' });
		await oauthClient('gitlab', CREDS('gitlab')).exchange('c', 'v');
		await oauthClient('microsoft', { ...CREDS('microsoft'), tenant: 'contoso' }).exchange(
			'c',
			'v'
		);
		expect(seen.map((s) => s.url)).toEqual([
			'https://gitlab.com/oauth/token',
			'https://login.microsoftonline.com/contoso/oauth2/v2.0/token'
		]);
	});

	it('rejects when the provider answers with an error body', async () => {
		stubToken({ error: 'bad_verification_code' });
		await expect(oauthClient('github', CREDS('github')).exchange('c', 'v')).rejects.toThrow();
	});
});
