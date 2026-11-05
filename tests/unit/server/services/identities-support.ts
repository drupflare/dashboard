import { toBase64Url } from '@contracts/common';
import { DuplicateRowError } from '../../../../src/server/db/collegedb';
import type { Identity } from '../../../../src/server/db/repos/identity';
import {
	OAUTH_PROVIDERS,
	oauthClient,
	type FetchLike,
	type OAuthClients,
	type OAuthProvider,
	type ProviderProfile,
	type ProviderTokens
} from '../../../../src/server/integrations/oauth';
import type { PasskeyRecord } from '../../../../src/server/integrations/webauthn';
import type { IdentityDeps, IdentityStore } from '../../../../src/server/services/identities';
import { nowUtc } from '../../../../src/shared/utils/time';
import { harness, type Harness } from './auth-support';

const tick = () => Promise.resolve();

export interface MemoryStore extends IdentityStore {
	identities: Identity[];
	passkeys: PasskeyRecord[];
	orgOf: Map<string, string>;
}

// the unique (provider, subject) pair is checked at insert time, as the d1 table would
export function memoryStore(): MemoryStore {
	const identities: Identity[] = [];
	const passkeys: PasskeyRecord[] = [];
	const orgOf = new Map<string, string>();
	let counter = 0;
	return {
		identities,
		passkeys,
		orgOf,
		async findIdentity(provider, subject) {
			await tick();
			return (
				identities.find((i) => i.provider === provider && i.providerSubject === subject) ??
				null
			);
		},
		async listIdentities(userId) {
			await tick();
			return identities.filter((i) => i.userId === userId);
		},
		async createIdentity(input) {
			await tick();
			if (
				identities.some(
					(i) =>
						i.provider === input.provider && i.providerSubject === input.providerSubject
				)
			) {
				throw new DuplicateRowError('UNIQUE constraint failed: identities.provider');
			}
			const identity: Identity = {
				id: `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
				...input,
				createdAt: nowUtc().toMillis()
			};
			identities.push(identity);
			return identity;
		},
		async deleteIdentity(userId, id) {
			await tick();
			const at = identities.findIndex((i) => i.id === id && i.userId === userId);
			if (at === -1) return false;
			identities.splice(at, 1);
			return true;
		},
		async personalOrganizationId(userId) {
			await tick();
			return orgOf.get(userId) ?? null;
		},
		async listPasskeys(userId) {
			await tick();
			return passkeys.filter((p) => p.userId === userId);
		},
		async getPasskey(id) {
			await tick();
			return passkeys.find((p) => p.id === id) ?? null;
		},
		async insertPasskey(passkey) {
			await tick();
			if (passkeys.some((p) => p.id === passkey.id)) {
				throw new DuplicateRowError('UNIQUE constraint failed: passkeys.id');
			}
			passkeys.push({ ...passkey });
		},
		async advancePasskeyCounter(id, from, to, usedAt) {
			await tick();
			const passkey = passkeys.find((p) => p.id === id);
			if (!passkey || passkey.counter !== from) return false;
			passkey.counter = to;
			passkey.lastUsedAt = usedAt;
			return true;
		},
		async renamePasskey(userId, id, name) {
			await tick();
			const passkey = passkeys.find((p) => p.id === id && p.userId === userId);
			if (!passkey) return false;
			passkey.name = name;
			return true;
		},
		async deletePasskey(userId, id) {
			await tick();
			const at = passkeys.findIndex((p) => p.id === id && p.userId === userId);
			if (at === -1) return false;
			passkeys.splice(at, 1);
			return true;
		}
	};
}

// #region fake providers

export const RP = {
	rpId: 'dash.example.com',
	rpName: 'Drupflare',
	origin: 'https://dash.example.com'
};

export const CREDS = (provider: OAuthProvider) => ({
	clientId: `${provider}-client`,
	clientSecret: `${provider}-secret`,
	redirectUri: `https://dash.example.com/auth/callback/${provider}`
});

const b64json = (value: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));

export function idToken(claims: Record<string, unknown>): string {
	return `${b64json({ alg: 'RS256', typ: 'JWT' })}.${b64json(claims)}.sig`;
}

export interface Reply {
	status?: number;
	body: unknown;
}

export interface FakeFetch {
	fn: FetchLike;
	calls: { url: string; authorization: string | null }[];
	replies: Map<string, Reply>;
}

// answers by exact url; an unlisted url is a 404 so a stray call fails loudly
export function fakeFetch(): FakeFetch {
	const calls: FakeFetch['calls'] = [];
	const replies = new Map<string, Reply>();
	return {
		calls,
		replies,
		fn: async (url, init) => {
			const headers = new Headers(init?.headers);
			calls.push({ url, authorization: headers.get('authorization') });
			const reply = replies.get(url);
			if (!reply) return new Response('{}', { status: 404 });
			return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
		}
	};
}

export const PROFILE_URLS = {
	githubUser: 'https://api.github.com/user',
	githubEmails: 'https://api.github.com/user/emails',
	gitlab: 'https://gitlab.com/oauth/userinfo',
	google: 'https://openidconnect.googleapis.com/v1/userinfo'
};

// primes the profile endpoints so a callback for the provider yields the given profile
export function primeProfile(
	f: FakeFetch,
	provider: OAuthProvider,
	profile: ProviderProfile
): ProviderTokens {
	switch (provider) {
		case 'github':
			f.replies.set(PROFILE_URLS.githubUser, {
				body: { id: Number(profile.subject), name: profile.name }
			});
			f.replies.set(PROFILE_URLS.githubEmails, {
				body:
					profile.email === null
						? []
						: [{ email: profile.email, primary: true, verified: profile.emailVerified }]
			});
			return { accessToken: 'gh-token', idToken: null };
		case 'gitlab':
		case 'google':
			f.replies.set(PROFILE_URLS[provider], {
				body: {
					sub: profile.subject,
					name: profile.name,
					email: profile.email,
					email_verified: profile.emailVerified
				}
			});
			return { accessToken: `${provider}-token`, idToken: null };
		case 'microsoft':
			return {
				accessToken: 'ms-token',
				idToken: idToken({
					sub: profile.subject,
					aud: CREDS('microsoft').clientId,
					name: profile.name,
					email: profile.email,
					...(profile.emailVerified ? { xms_edov: true } : {})
				})
			};
	}
}

// #endregion

export interface IdentityHarness extends Harness, Omit<IdentityDeps, 'kv' | 'directory'> {
	store: MemoryStore;
	fetchLog: FakeFetch;
	tokens: Partial<Record<OAuthProvider, ProviderTokens>>;
	exchanges: { provider: OAuthProvider; code: string; verifier: string }[];
}

// real arctic clients with the code exchange replaced, since that is the only call that needs a network
export function identityHarness(options: { emailFloor?: boolean } = {}): IdentityHarness {
	const base = harness();
	const store = memoryStore();
	const fetchLog = fakeFetch();
	const tokens: IdentityHarness['tokens'] = {};
	const exchanges: IdentityHarness['exchanges'] = [];
	const clients: OAuthClients = {};
	for (const provider of OAUTH_PROVIDERS) {
		clients[provider] = {
			...oauthClient(provider, CREDS(provider)),
			exchange: async (code, verifier) => {
				exchanges.push({ provider, code, verifier });
				const issued = tokens[provider];
				if (!issued) throw new Error('the provider refused the code');
				return issued;
			}
		};
	}
	const base2 = base.directory;
	// the personal organisation a sign-up creates is the audit trail the store reports
	const createOrg = base2.createPersonalOrganization.bind(base2);
	base2.createPersonalOrganization = async (user) => {
		const org = await createOrg(user);
		store.orgOf.set(user.id, org.id);
		return org;
	};
	return {
		...base,
		store,
		fetchLog,
		tokens,
		exchanges,
		webauthn: RP,
		clients,
		fetch: fetchLog.fn,
		...(options.emailFloor === undefined ? {} : { emailFloor: options.emailFloor })
	};
}
