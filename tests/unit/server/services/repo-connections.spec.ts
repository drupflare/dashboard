import { toBase64Url } from '@contracts/common';
import { describe, expect, it } from 'vitest';
import type { ConnectionRow, RemoteRow } from '../../../../src/server/db/repos/repo-connections';
import type { ProviderFetch } from '../../../../src/server/integrations/git-providers';
import { guardedProviderFetch } from '../../../../src/server/integrations/git-providers/guard';
import { hmacSha256Hex } from '../../../../src/server/services/crypto';
import {
	acceptDelivery,
	attachRemote,
	completeConnect,
	listRepositories,
	revokeConnection,
	startConnect,
	type RepoConnectionDeps,
	type RepoConnectionStore
} from '../../../../src/server/services/repo-connections';
import type { OnceStore } from '../../../../src/server/services/single-use';
import { loadKeyRing } from '../../../../src/shared/custody/envelope';
import { ApiError } from '../../../../src/shared/errors';

const NOW = 1_800_000_000_000;
const ORG = 'org_1';
const TOKEN = 'glpat-plain-token-value';
const DNS: Record<string, string[]> = {
	'git.example.org': ['93.184.216.34'],
	'loop.example.org': ['127.0.0.1'],
	'meta.example.org': ['169.254.169.254'],
	'hub.example.org': ['93.184.216.35'],
	'github.com': ['140.82.112.3'],
	'api.github.com': ['140.82.112.5']
};
const resolve = async (hostname: string): Promise<string[]> => DNS[hostname] ?? [];

function fakeStore() {
	const connections = new Map<string, ConnectionRow>();
	const remotes = new Map<string, RemoteRow>();
	const deliveries = new Set<string>();
	const store: RepoConnectionStore = {
		async insertConnection(row) {
			connections.set(row.id, { ...row });
		},
		async getConnection(orgId, id) {
			const row = connections.get(id);
			return row && row.organizationId === orgId ? { ...row } : null;
		},
		async listConnections(orgId) {
			return [...connections.values()]
				.filter((r) => r.organizationId === orgId)
				.map((r) => ({ ...r }));
		},
		async activeByExternal(provider, externalId) {
			const row = [...connections.values()].find(
				(r) =>
					r.provider === provider && r.externalId === externalId && r.state === 'active'
			);
			return row ? { ...row } : null;
		},
		async setCredential(id, envelope) {
			const row = connections.get(id);
			if (!row || row.state !== 'active') return false;
			row.credentialEnvelope = envelope;
			return true;
		},
		async revokeConnection(orgId, id, now) {
			const row = connections.get(id);
			if (!row || row.organizationId !== orgId || row.state !== 'active') return false;
			Object.assign(row, { state: 'revoked', credentialEnvelope: null, revokedAt: now });
			return true;
		},
		async insertRemote(row) {
			remotes.set(row.id, { ...row });
		},
		async listRemotes(orgId, siteId) {
			return [...remotes.values()].filter(
				(r) => r.organizationId === orgId && r.siteId === siteId
			);
		},
		async remotesForPush(provider, repo, branch) {
			return [...remotes.values()]
				.filter((r) => {
					const c = connections.get(r.connectionId);
					return (
						c?.provider === provider &&
						c.state === 'active' &&
						r.repoFullName === repo &&
						r.branch === branch
					);
				})
				.map((r) => ({ ...r }));
		},
		async setPull(id, status, at) {
			const row = remotes.get(id);
			if (row) Object.assign(row, { lastPullStatus: status, lastPullAt: at });
		},
		async hasDelivery(provider, id) {
			return deliveries.has(`${provider}:${id}`);
		},
		async recordDelivery(provider, id) {
			deliveries.add(`${provider}:${id}`);
		}
	};
	return { store, connections, remotes };
}

function fakeOnce(): OnceStore {
	const values = new Map<string, { value: string; expiresAt: number }>();
	const take = async (key: string, now: number) => {
		const entry = values.get(key);
		values.delete(key);
		return entry && entry.expiresAt > now ? entry.value : null;
	};
	return {
		async put(key, value, expiresAt) {
			values.set(key, { value, expiresAt });
		},
		async get(key, now) {
			const entry = values.get(key);
			return entry && entry.expiresAt > now ? entry.value : null;
		},
		take,
		async takeIf() {
			return false;
		}
	};
}

const githubReply = (installations: number[]) => (url: string) => {
	if (url.includes('/login/oauth/access_token'))
		return Response.json({ access_token: 'ghu_user' });
	if (url.includes('/user/installations')) {
		return Response.json({ installations: installations.map((id) => ({ id })) });
	}
	return Response.json([]);
};

async function harness(reply: (url: string) => Response = () => Response.json([])) {
	const { store, connections, remotes } = fakeStore();
	const calls: string[] = [];
	const transport: ProviderFetch = async (url) => {
		calls.push(url);
		return reply(url);
	};
	const pulls: string[] = [];
	const deps: RepoConnectionDeps = {
		store,
		once: fakeOnce(),
		ring: await loadKeyRing({ KEK_V1: toBase64Url(new Uint8Array(32).fill(7)) }),
		fetch: guardedProviderFetch({ fetch: transport, resolve }),
		resolve,
		now: () => NOW,
		github: {
			appId: '1',
			privateKey: '',
			slug: 'drupflare',
			clientId: 'ghcid',
			clientSecret: 'ghsecret',
			webhookSecret: 'gh-secret'
		},
		gitlab: {
			clientId: 'cid',
			clientSecret: 'csecret',
			redirectUri: 'https://app.example/cb',
			webhookSecret: 'gl-secret'
		},
		pullRemote: async (remote, sha) => {
			pulls.push(`${remote.id}@${sha}`);
			return 'installed';
		},
		audit: async () => {}
	};
	return { deps, connections, remotes, calls, pulls };
}

async function refusedWith(work: () => Promise<unknown>): Promise<ApiError> {
	try {
		await work();
	} catch (error) {
		if (error instanceof ApiError) return error;
		throw error;
	}
	throw new Error('expected a refusal');
}

describe('startConnect and completeConnect', () => {
	it('starts a GitHub install with a state that only the same org can finish', async () => {
		const { deps } = await harness();
		const start = await startConnect(deps, { orgId: ORG, provider: 'github' });
		expect(start.kind).toBe('redirect');
		const state =
			start.kind === 'redirect' ? new URL(start.url).searchParams.get('state') : null;
		expect(state).not.toBeNull();
		const other = await refusedWith(() =>
			completeConnect(deps, {
				orgId: 'org_2',
				provider: 'github',
				state: state ?? '',
				installationId: '42'
			})
		);
		expect(other.code).toBe('validation');
	});

	async function githubState(deps: RepoConnectionDeps, orgId = ORG): Promise<string> {
		const start = await startConnect(deps, { orgId, provider: 'github' });
		return start.kind === 'redirect'
			? (new URL(start.url).searchParams.get('state') ?? '')
			: '';
	}

	it('stores a GitHub installation with no credential envelope', async () => {
		const { deps, connections } = await harness(githubReply([42]));
		const state = await githubState(deps);
		const view = await completeConnect(deps, {
			orgId: ORG,
			provider: 'github',
			state,
			installationId: '42',
			code: 'user-code'
		});
		expect(view.provider).toBe('github');
		expect(connections.get(view.id)?.credentialEnvelope).toBeNull();
	});

	it('refuses an installation the signed-in user cannot reach', async () => {
		const { deps, connections } = await harness(githubReply([7]));
		const state = await githubState(deps);
		const error = await refusedWith(() =>
			completeConnect(deps, {
				orgId: ORG,
				provider: 'github',
				state,
				installationId: '42',
				code: 'user-code'
			})
		);
		expect(error.code).toBe('validation');
		expect(connections.size).toBe(0);
	});

	it('refuses a GitHub callback with no authorization code', async () => {
		const { deps, connections, calls } = await harness(githubReply([42]));
		const state = await githubState(deps);
		const error = await refusedWith(() =>
			completeConnect(deps, { orgId: ORG, provider: 'github', state, installationId: '42' })
		);
		expect(error.code).toBe('validation');
		expect(calls).toHaveLength(0);
		expect(connections.size).toBe(0);
	});

	it('refuses a code GitHub does not accept', async () => {
		const { deps, connections } = await harness(() =>
			Response.json({ error: 'bad_verification_code' })
		);
		const state = await githubState(deps);
		const error = await refusedWith(() =>
			completeConnect(deps, {
				orgId: ORG,
				provider: 'github',
				state,
				installationId: '42',
				code: 'stale'
			})
		);
		expect(error.code).toBe('validation');
		expect(connections.size).toBe(0);
	});

	it('refuses an installation already connected to another organization', async () => {
		const { deps, connections } = await harness(githubReply([42]));
		await completeConnect(deps, {
			orgId: 'org_2',
			provider: 'github',
			state: await githubState(deps, 'org_2'),
			installationId: '42',
			code: 'user-code'
		});
		const state = await githubState(deps);
		const error = await refusedWith(() =>
			completeConnect(deps, {
				orgId: ORG,
				provider: 'github',
				state,
				installationId: '42',
				code: 'user-code'
			})
		);
		expect(error.code).toBe('validation');
		expect(connections.size).toBe(1);
	});

	it('refuses a host that is not public before a token is sent', async () => {
		const bad = [
			'http://git.example.org',
			'https://93.184.216.34',
			'https://loop.example.org',
			'https://meta.example.org'
		];
		for (const baseUrl of bad) {
			const { deps, calls } = await harness();
			const error = await refusedWith(() =>
				startConnect(deps, { orgId: ORG, provider: 'gitea', token: TOKEN, baseUrl })
			);
			expect(error.code, baseUrl).toBe('validation');
			expect(calls, baseUrl).toHaveLength(0);
		}
	});

	it('stores a token only as an encrypted envelope and lists through it', async () => {
		const { deps, connections, calls } = await harness(() =>
			Response.json([{ full_name: 'ops/site', default_branch: 'main' }])
		);
		const result = await startConnect(deps, {
			orgId: ORG,
			provider: 'gitea',
			token: TOKEN,
			baseUrl: 'https://git.example.org'
		});
		expect(result.kind).toBe('connected');
		if (result.kind !== 'connected') return;
		const stored = connections.get(result.connection.id);
		expect(JSON.stringify(stored)).not.toContain(TOKEN);
		expect(JSON.parse(stored?.credentialEnvelope ?? '{}')).toMatchObject({ v: 1 });
		const repos = await listRepositories(deps, ORG, result.connection.id);
		expect(repos).toEqual([{ fullName: 'ops/site', defaultBranch: 'main' }]);
		expect(calls.every((url) => url.startsWith('https://git.example.org/'))).toBe(true);
	});

	it('refuses a missing token for a token provider', async () => {
		const { deps } = await harness();
		const error = await refusedWith(() =>
			startConnect(deps, { orgId: ORG, provider: 'bitbucket' })
		);
		expect(error.code).toBe('validation');
	});
});

describe('revokeConnection', () => {
	it('clears the stored envelope and refuses later listing', async () => {
		const { deps, connections } = await harness(() => Response.json([]));
		const result = await startConnect(deps, {
			orgId: ORG,
			provider: 'gitea',
			token: TOKEN,
			baseUrl: 'https://git.example.org'
		});
		if (result.kind !== 'connected') throw new Error('expected a connection');
		const view = await revokeConnection(deps, ORG, result.connection.id);
		expect(view.state).toBe('revoked');
		expect(connections.get(result.connection.id)?.credentialEnvelope).toBeNull();
		const again = await revokeConnection(deps, ORG, result.connection.id);
		expect(again.state).toBe('revoked');
		const error = await refusedWith(() => listRepositories(deps, ORG, result.connection.id));
		expect(error.code).toBe('unprocessable');
	});

	it('answers not found for another org', async () => {
		const { deps } = await harness();
		const error = await refusedWith(() => revokeConnection(deps, 'org_2', 'missing'));
		expect(error.code).toBe('not_found');
	});
});

describe('attachRemote', () => {
	async function connected() {
		const h = await harness(() => Response.json([]));
		const result = await startConnect(h.deps, {
			orgId: ORG,
			provider: 'gitea',
			token: TOKEN,
			baseUrl: 'https://git.example.org'
		});
		if (result.kind !== 'connected') throw new Error('expected a connection');
		return { ...h, connectionId: result.connection.id };
	}

	it('refuses a mount outside the three folders, a short interval and a bad branch', async () => {
		const { deps, connectionId } = await connected();
		const base = {
			orgId: ORG,
			siteId: 'site_1',
			connectionId,
			repo: 'ops/site',
			branch: 'main'
		};
		for (const extra of [
			{ mountPath: '../etc' },
			{ mountPath: 'modules/custom/x', intervalMinutes: 4 },
			{ mountPath: 'modules/custom/x', branch: 'bad branch' }
		]) {
			const error = await refusedWith(() => attachRemote(deps, { ...base, ...extra }));
			expect(error.code).toBe('validation');
		}
	});

	it('attaches a remote with the default interval', async () => {
		const { deps, connectionId, remotes } = await connected();
		const view = await attachRemote(deps, {
			orgId: ORG,
			siteId: 'site_1',
			connectionId,
			repo: 'ops/site',
			branch: 'main',
			mountPath: 'modules/custom/site'
		});
		expect(view.intervalMinutes).toBe(60);
		expect(remotes.has(view.id)).toBe(true);
	});
});

describe('acceptDelivery', () => {
	async function githubRemote() {
		const h = await harness(githubReply([42]));
		const start = await startConnect(h.deps, { orgId: ORG, provider: 'github' });
		const state =
			start.kind === 'redirect' ? (new URL(start.url).searchParams.get('state') ?? '') : '';
		const connection = await completeConnect(h.deps, {
			orgId: ORG,
			provider: 'github',
			state,
			installationId: '42',
			code: 'user-code'
		});
		await attachRemote(h.deps, {
			orgId: ORG,
			siteId: 'site_1',
			connectionId: connection.id,
			repo: 'ops/site',
			branch: 'main',
			mountPath: 'modules/custom/site'
		});
		return h;
	}

	const pushBody = (installationId: number, ref = 'refs/heads/main') =>
		JSON.stringify({
			ref,
			after: 'a'.repeat(40),
			repository: { full_name: 'ops/site' },
			installation: { id: installationId }
		});

	async function sign(body: string) {
		return `sha256=${await hmacSha256Hex('gh-secret', body)}`;
	}

	it('refuses a bad signature and pulls nothing', async () => {
		const h = await githubRemote();
		const body = pushBody(42);
		const error = await refusedWith(() =>
			acceptDelivery(h.deps, 'github', {
				eventName: 'push',
				deliveryId: 'd1',
				rawBody: body,
				signature: 'sha256=00'
			})
		);
		expect(error.code).toBe('validation');
		expect(h.pulls).toHaveLength(0);
	});

	it('pulls the matching remote once and ignores a redelivery', async () => {
		const h = await githubRemote();
		const body = pushBody(42);
		const first = await acceptDelivery(h.deps, 'github', {
			eventName: 'push',
			deliveryId: 'd1',
			rawBody: body,
			signature: await sign(body)
		});
		expect(first).toEqual({ duplicate: false, matched: 1 });
		const again = await acceptDelivery(h.deps, 'github', {
			eventName: 'push',
			deliveryId: 'd1',
			rawBody: body,
			signature: await sign(body)
		});
		expect(again).toEqual({ duplicate: true, matched: 0 });
		expect(h.pulls).toHaveLength(1);
	});

	it('does not pull for another branch or another installation', async () => {
		const h = await githubRemote();
		const other = pushBody(42, 'refs/heads/dev');
		const wrongInstall = pushBody(7);
		for (const [id, body] of [
			['d2', other],
			['d3', wrongInstall]
		] as const) {
			const result = await acceptDelivery(h.deps, 'github', {
				eventName: 'push',
				deliveryId: id,
				rawBody: body,
				signature: await sign(body)
			});
			expect(result.matched).toBe(0);
		}
		expect(h.pulls).toHaveLength(0);
	});

	it('records a failed pull on the remote and still closes the delivery', async () => {
		const h = await githubRemote();
		h.deps.pullRemote = async () => {
			throw new Error('worker refused');
		};
		const body = pushBody(42);
		const result = await acceptDelivery(h.deps, 'github', {
			eventName: 'push',
			deliveryId: 'd4',
			rawBody: body,
			signature: await sign(body)
		});
		expect(result).toEqual({ duplicate: false, matched: 1 });
		const [remote] = [...h.remotes.values()];
		expect(remote?.lastPullStatus).toBe('failed');
	});

	it('accepts a GitLab push with the plain secret header and ignores a tag push', async () => {
		const h = await harness();
		const connection = await h.deps.store.insertConnection({
			id: 'gl_1',
			organizationId: ORG,
			provider: 'gitlab',
			externalId: 'gitlab.com',
			displayName: 'GitLab gitlab.com',
			credentialEnvelope: null,
			scopes: [],
			state: 'active',
			createdAt: NOW,
			revokedAt: null
		});
		void connection;
		await h.deps.store.insertRemote({
			id: 'rem_gl',
			siteId: 'site_1',
			organizationId: ORG,
			connectionId: 'gl_1',
			repoFullName: 'group/project',
			branch: 'main',
			mountPath: 'modules/custom/project',
			intervalMinutes: 60,
			lastPullStatus: null,
			lastPullAt: null,
			createdAt: NOW
		});
		const body = JSON.stringify({
			object_kind: 'push',
			ref: 'refs/heads/main',
			checkout_sha: 'b'.repeat(40),
			project: { path_with_namespace: 'group/project' }
		});
		const denied = await refusedWith(() =>
			acceptDelivery(h.deps, 'gitlab', {
				eventName: 'Push Hook',
				deliveryId: 'g1',
				rawBody: body,
				signature: 'wrong'
			})
		);
		expect(denied.code).toBe('validation');
		const ok = await acceptDelivery(h.deps, 'gitlab', {
			eventName: 'Push Hook',
			deliveryId: 'g2',
			rawBody: body,
			signature: 'gl-secret'
		});
		expect(ok).toEqual({ duplicate: false, matched: 1 });
		const tag = JSON.stringify({
			object_kind: 'push',
			ref: 'refs/tags/v1',
			checkout_sha: 'c'.repeat(40),
			project: { path_with_namespace: 'group/project' }
		});
		const tagged = await acceptDelivery(h.deps, 'gitlab', {
			eventName: 'Push Hook',
			deliveryId: 'g3',
			rawBody: tag,
			signature: 'gl-secret'
		});
		expect(tagged.matched).toBe(0);
		expect(h.pulls).toHaveLength(1);
	});
});
