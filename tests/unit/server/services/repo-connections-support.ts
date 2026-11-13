import { toBase64Url } from '@contracts/common';
import type { Operation } from '@contracts/operations';
import type { StoredOperation } from '../../../../src/server/db/repos/operations';
import type { ConnectionRow, RemoteRow } from '../../../../src/server/db/repos/repo-connections';
import type { ProviderFetch } from '../../../../src/server/integrations/git-providers';
import { guardedProviderFetch } from '../../../../src/server/integrations/git-providers/guard';
import { hmacSha256Hex } from '../../../../src/server/services/crypto';
import {
	completeConnect,
	startConnect,
	type RepoConnectionDeps,
	type RepoConnectionStore
} from '../../../../src/server/services/repo-connections';
import type { OnceStore } from '../../../../src/server/services/single-use';
import { loadKeyRing } from '../../../../src/shared/custody/envelope';

export const NOW = 1_800_000_000_000;

export function fakePullOperation(siteId: string): StoredOperation['operation'] {
	const at = new Date(NOW).toISOString();
	return {
		id: `op_${'p'.repeat(26)}` as Operation['id'],
		orgId: ORG as Operation['orgId'],
		type: 'git.pull',
		status: 'planned',
		idempotencyKey: 'key',
		targetIds: [siteId],
		preconditions: [],
		planDigest: `sha256:${'0'.repeat(64)}`,
		fencingEpoch: 0,
		blastRadius: { sites: 1, destructiveSites: 0, productionDeploys: 0 },
		rollbackPoint: null,
		cursor: null,
		steps: [],
		verification: 'pending',
		finalObservation: null,
		budget: {
			maxDestructiveSites: 5,
			maxConcurrentProductionDeploys: 10,
			elevated: false,
			bulkDeleteConfirmation: null
		},
		createdAt: at,
		updatedAt: at
	};
}
export const ORG = 'org_1';
export const TOKEN = 'glpat-plain-token-value';
export const WEBHOOK_SECRET = 'gh-secret';
const DNS: Record<string, string[]> = {
	'git.example.org': ['93.184.216.34'],
	'loop.example.org': ['127.0.0.1'],
	'meta.example.org': ['169.254.169.254'],
	'hub.example.org': ['93.184.216.35'],
	'github.com': ['140.82.112.3'],
	'api.github.com': ['140.82.112.5']
};
export const resolve = async (hostname: string): Promise<string[]> => DNS[hostname] ?? [];

export function fakeStore() {
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
		async setPull(id, status, at, reason) {
			const row = remotes.get(id);
			if (row)
				Object.assign(row, {
					lastPullStatus: status,
					lastPullAt: at,
					lastPullReason: reason
				});
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

export function fakeOnce(): OnceStore {
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

export const githubReply = (installations: number[]) => (url: string) => {
	if (url.includes('/login/oauth/access_token'))
		return Response.json({ access_token: 'ghu_user' });
	if (url.includes('/user/installations')) {
		return Response.json({ installations: installations.map((id) => ({ id })) });
	}
	return Response.json([]);
};

export async function harness(reply: (url: string) => Response = () => Response.json([])) {
	const { store, connections, remotes } = fakeStore();
	const calls: string[] = [];
	const transport: ProviderFetch = async (url) => {
		calls.push(url);
		return reply(url);
	};
	const pulls: string[] = [];
	const ring = await loadKeyRing({ KEK_V1: toBase64Url(new Uint8Array(32).fill(7)) });
	const deps: RepoConnectionDeps = {
		store,
		once: fakeOnce(),
		ring: async () => ring,
		fetch: guardedProviderFetch({ fetch: transport, resolve }),
		resolve,
		now: () => NOW,
		github: {
			appId: '1',
			privateKey: '',
			slug: 'drupflare',
			clientId: 'ghcid',
			clientSecret: 'ghsecret',
			webhookSecret: WEBHOOK_SECRET
		},
		gitlab: {
			clientId: 'cid',
			clientSecret: 'csecret',
			redirectUri: 'https://app.example/cb',
			webhookSecret: 'gl-secret'
		},
		pullRemote: async (remote, trigger) => {
			pulls.push(`${remote.id}:${trigger.key}`);
			return { operation: fakePullOperation(remote.siteId), version: 0 };
		},
		audit: async () => {}
	};
	return { deps, connections, remotes, calls, pulls };
}

export const pushBody = (installationId: number, ref = 'refs/heads/main') =>
	JSON.stringify({
		ref,
		after: 'a'.repeat(40),
		repository: { full_name: 'ops/site' },
		installation: { id: installationId }
	});

export async function signBody(body: string): Promise<string> {
	return `sha256=${await hmacSha256Hex(WEBHOOK_SECRET, body)}`;
}

export async function githubConnection() {
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
	return { ...h, connection, state };
}
