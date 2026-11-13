import { afterEach, describe, expect, it } from 'vitest';
import repositories from '../../../../src/server/api/v1/orgs/[orgId]/repo-connections/[id]/repositories.get';
import revoke from '../../../../src/server/api/v1/orgs/[orgId]/repo-connections/[id]/revoke.post';
import complete from '../../../../src/server/api/v1/orgs/[orgId]/repo-connections/complete.post';
import connectionsList from '../../../../src/server/api/v1/orgs/[orgId]/repo-connections/index.get';
import connect from '../../../../src/server/api/v1/orgs/[orgId]/repo-connections/index.post';
import remotesList from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/remotes/index.get';
import attach from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/remotes/index.post';
import { setRepoConnectionDeps } from '../../../../src/server/services/repo-connections';
import { resetApiDeps, type LoadInput } from '../../../../src/server/utils/define-api';
import { isSessionOnly } from '../../../../src/shared/permissions';
import {
	connectStartSchema,
	connectionListSchema,
	connectionViewSchema,
	remoteListSchema,
	remoteViewSchema,
	repoListSchema
} from '../../../../src/shared/repo-connections';
import { DEPT, ORG, OTHER_ORG, facts, fresh, member } from '../../domain/fixtures';
import { asKey, asUser, send, setup } from '../fixtures/harness';
import { TOKEN, githubReply, harness } from '../services/repo-connections-support';

const SITE = 'site_aaaaaaaa';
const BASE = `/api/v1/orgs/${ORG}/repo-connections`;
const ROUTE = '/api/v1/orgs/:orgId/repo-connections';
const REMOTES = `/api/v1/orgs/${ORG}/sites/${SITE}/remotes`;
const REMOTES_ROUTE = '/api/v1/orgs/:orgId/sites/:id/remotes';
const GIT = { provider: 'gitea', token: TOKEN, baseUrl: 'https://git.example.org' };

afterEach(() => {
	setRepoConnectionDeps(null);
	resetApiDeps();
});

// the loader answers for the organisation in the path and the site in the path, as the real one does
function load(
	options: { role?: 'viewer' | 'developer' | 'admin' | 'owner' | null; stale?: boolean } = {}
) {
	return async (input: LoadInput) => {
		if (input.params.orgId !== ORG) return null;
		const role = options.role === undefined ? 'owner' : options.role;
		const standing = options.stale ? {} : fresh;
		const base =
			role === null ? facts({ ...standing }) : facts({ ...member(role), ...standing });
		return {
			resource: {
				orgId: ORG,
				departmentId: DEPT,
				...(input.scope === 'site' ? { siteId: input.params.id } : {})
			},
			facts:
				input.principal.kind === 'key'
					? {
							...base,
							key: {
								id: 'key-1',
								scopes: [
									'repo.connect',
									'repo.read',
									'site.remote.manage',
									'site.read'
								]
							}
						}
					: base
		};
	};
}

async function ready(role: Parameters<typeof load>[0] = {}, reply?: (url: string) => Response) {
	const h = await harness(
		reply ?? (() => Response.json([{ full_name: 'ops/site', default_branch: 'main' }]))
	);
	setRepoConnectionDeps(h.deps);
	const api = setup({ deps: { load: load(role) } });
	return { ...h, denials: api.denials };
}

const post = (
	handler: Parameters<typeof send>[0],
	route: string,
	path: string,
	json: unknown,
	headers: Record<string, string> = asUser
) => send(handler, route, { method: 'POST', path, json, headers });

async function connectWithToken() {
	const reply = await post(connect, ROUTE, BASE, GIT);
	return connectStartSchema.parse(reply.json);
}

describe('who may use the repository routes', () => {
	it('marks connecting as session only and holds the rest to the organisation roles', () => {
		expect(isSessionOnly('repo.connect')).toBe(true);
		expect(isSessionOnly('repo.read')).toBe(false);
		expect(isSessionOnly('site.remote.manage')).toBe(false);
	});

	it('lets a viewer read connections and remotes and refuses a viewer every change', async () => {
		await ready({ role: 'viewer' });
		const list = await send(connectionsList, ROUTE, { path: BASE, headers: asUser });
		const remotes = await send(remotesList, REMOTES_ROUTE, { path: REMOTES, headers: asUser });
		expect([list.status, remotes.status]).toEqual([200, 200]);
		const start = await post(connect, ROUTE, BASE, GIT);
		const finish = await post(complete, `${ROUTE}/complete`, `${BASE}/complete`, {
			provider: 'github',
			state: 'x'
		});
		const attached = await post(attach, REMOTES_ROUTE, REMOTES, {
			connectionId: 'c',
			repo: 'ops/site',
			branch: 'main',
			mountPath: 'modules/custom/site'
		});
		expect([start.status, finish.status, attached.status]).toEqual([403, 403, 403]);
	});

	it('lets a developer attach a repository and refuses the same developer a connection', async () => {
		const h = await ready({ role: 'admin' });
		const made = await connectWithToken();
		if (made.kind !== 'connected') throw new Error('expected a connection');
		setup({ deps: { load: load({ role: 'developer' }) } });
		const refused = await post(connect, ROUTE, BASE, GIT);
		expect(refused.status).toBe(403);
		const revoked = await post(
			revoke,
			`${ROUTE}/:id/revoke`,
			`${BASE}/${made.connection.id}/revoke`,
			{}
		);
		expect(revoked.status).toBe(403);
		const attached = await post(attach, REMOTES_ROUTE, REMOTES, {
			connectionId: made.connection.id,
			repo: 'ops/site',
			branch: 'main',
			mountPath: 'modules/custom/site'
		});
		expect(attached.status).toBe(201);
		expect(h.remotes.size).toBe(1);
	});

	it('refuses an API key on a connection change, whatever its scopes', async () => {
		const { denials } = await ready();
		const start = await post(connect, ROUTE, BASE, GIT, asKey);
		const finish = await post(
			complete,
			`${ROUTE}/complete`,
			`${BASE}/complete`,
			{ provider: 'github', state: 'x' },
			asKey
		);
		const revoked = await post(revoke, `${ROUTE}/:id/revoke`, `${BASE}/c1/revoke`, {}, asKey);
		expect([start.status, finish.status, revoked.status]).toEqual([403, 403, 403]);
		expect(denials.map((denial) => denial.reason)).toEqual([
			'session_only',
			'session_only',
			'session_only'
		]);
	});

	it('asks for a fresh sign-in before it starts or finishes a connection', async () => {
		const h = await ready({ stale: true });
		const start = await post(connect, ROUTE, BASE, GIT);
		expect(start.status).toBe(403);
		expect(start.json).toMatchObject({ details: { requires: 'step-up' } });
		expect(h.calls).toEqual([]);
		expect(h.connections.size).toBe(0);
	});

	it('answers not found for another organisation', async () => {
		await ready();
		const path = `/api/v1/orgs/${OTHER_ORG}/repo-connections`;
		const list = await send(connectionsList, ROUTE, { path, headers: asUser });
		expect(list.status).toBe(404);
	});
});

describe('the repository routes against a token provider', () => {
	it('starts, lists, lists repositories, attaches, lists remotes and revokes', async () => {
		const h = await ready();
		const made = await connectWithToken();
		expect(made.kind).toBe('connected');
		if (made.kind !== 'connected') return;
		const id = made.connection.id;
		expect(made.connection).toMatchObject({ provider: 'gitea', state: 'active' });
		expect(JSON.stringify(h.connections.get(id))).not.toContain(TOKEN);

		const list = await send(connectionsList, ROUTE, { path: BASE, headers: asUser });
		expect(connectionListSchema.parse(list.json).items.map((item) => item.id)).toEqual([id]);
		expect(list.text).not.toContain('credential');

		const repos = await send(repositories, `${ROUTE}/:id/repositories`, {
			path: `${BASE}/${id}/repositories`,
			headers: asUser
		});
		expect(repoListSchema.parse(repos.json).items).toEqual([
			{ fullName: 'ops/site', defaultBranch: 'main' }
		]);

		const attached = await post(attach, REMOTES_ROUTE, REMOTES, {
			connectionId: id,
			repo: 'ops/site',
			branch: 'main',
			mountPath: 'modules/custom/site'
		});
		expect(attached.status).toBe(201);
		const remote = remoteViewSchema.parse(attached.json);
		expect(remote).toMatchObject({ siteId: SITE, intervalMinutes: 60, lastPullStatus: null });

		const remotes = await send(remotesList, REMOTES_ROUTE, { path: REMOTES, headers: asUser });
		expect(remoteListSchema.parse(remotes.json).items.map((item) => item.id)).toEqual([
			remote.id
		]);

		const revoked = await post(revoke, `${ROUTE}/:id/revoke`, `${BASE}/${id}/revoke`, {});
		expect(revoked.status).toBe(200);
		expect(connectionViewSchema.parse(revoked.json).state).toBe('revoked');
		expect(h.connections.get(id)?.credentialEnvelope).toBeNull();
		const after = await send(repositories, `${ROUTE}/:id/repositories`, {
			path: `${BASE}/${id}/repositories`,
			headers: asUser
		});
		expect(after.status).toBe(422);
		const reattach = await post(attach, REMOTES_ROUTE, REMOTES, {
			connectionId: id,
			repo: 'ops/site',
			branch: 'main',
			mountPath: 'modules/custom/other'
		});
		expect(reattach.status).toBe(422);
	});

	it('writes the connect and the revoke to the audit chain with the connection id', async () => {
		const audits: string[] = [];
		const h = await harness(() => Response.json([]));
		h.deps.audit = async (orgId, action, target) =>
			void audits.push(`${orgId} ${action} ${target}`);
		setRepoConnectionDeps(h.deps);
		setup({ deps: { load: load() } });
		const made = await connectWithToken();
		if (made.kind !== 'connected') throw new Error('expected a connection');
		await post(revoke, `${ROUTE}/:id/revoke`, `${BASE}/${made.connection.id}/revoke`, {});
		expect(audits).toEqual([
			`${ORG} repo.connection.connect ${made.connection.id}`,
			`${ORG} repo.connection.revoke ${made.connection.id}`
		]);
	});

	it('refuses a host that is not public and a missing token, sending nothing', async () => {
		const h = await ready();
		const loop = await post(connect, ROUTE, BASE, {
			...GIT,
			baseUrl: 'https://loop.example.org'
		});
		const bare = await post(connect, ROUTE, BASE, { provider: 'bitbucket' });
		expect([loop.status, bare.status]).toEqual([400, 400]);
		expect(h.calls).toEqual([]);
	});

	it('refuses a body with an unknown provider or an extra field', async () => {
		await ready();
		const unknown = await post(connect, ROUTE, BASE, { ...GIT, provider: 'svn' });
		const extra = await post(connect, ROUTE, BASE, { ...GIT, organizationId: 'org-2' });
		expect([unknown.status, extra.status]).toEqual([400, 400]);
	});

	it('refuses an Idempotency-Key on the routes that carry a single-use value', async () => {
		await ready();
		const headers = { ...asUser, 'idempotency-key': 'key-repo-1' };
		const start = await post(connect, ROUTE, BASE, GIT, headers);
		const finish = await post(
			complete,
			`${ROUTE}/complete`,
			`${BASE}/complete`,
			{ provider: 'github', state: 'x' },
			headers
		);
		expect([start.status, finish.status]).toEqual([400, 400]);
	});

	it('does not attach a connection of another organisation or a bad mount path', async () => {
		const h = await ready();
		await h.deps.store.insertConnection({
			id: 'conn_other',
			organizationId: OTHER_ORG,
			provider: 'gitea',
			externalId: 'git.example.org',
			displayName: 'Gitea git.example.org',
			credentialEnvelope: null,
			scopes: [],
			state: 'active',
			createdAt: 1,
			revokedAt: null
		});
		const other = await post(attach, REMOTES_ROUTE, REMOTES, {
			connectionId: 'conn_other',
			repo: 'ops/site',
			branch: 'main',
			mountPath: 'modules/custom/site'
		});
		expect(other.status).toBe(404);
		const made = await connectWithToken();
		if (made.kind !== 'connected') throw new Error('expected a connection');
		const bad = await post(attach, REMOTES_ROUTE, REMOTES, {
			connectionId: made.connection.id,
			repo: 'ops/site',
			branch: 'main',
			mountPath: '../etc'
		});
		expect(bad.status).toBe(400);
		expect(h.remotes.size).toBe(0);
	});

	it('answers 501 on every route until the services are installed', async () => {
		setup({ deps: { load: load() } });
		const replies = await Promise.all([
			send(connectionsList, ROUTE, { path: BASE, headers: asUser }),
			post(connect, ROUTE, BASE, GIT),
			post(complete, `${ROUTE}/complete`, `${BASE}/complete`, {
				provider: 'github',
				state: 'x'
			}),
			post(revoke, `${ROUTE}/:id/revoke`, `${BASE}/c1/revoke`, {}),
			send(repositories, `${ROUTE}/:id/repositories`, {
				path: `${BASE}/c1/repositories`,
				headers: asUser
			}),
			post(attach, REMOTES_ROUTE, REMOTES, {
				connectionId: 'c1',
				repo: 'ops/site',
				branch: 'main',
				mountPath: 'modules/custom/site'
			}),
			send(remotesList, REMOTES_ROUTE, { path: REMOTES, headers: asUser })
		]);
		expect(replies.map((reply) => reply.status)).toEqual([501, 501, 501, 501, 501, 501, 501]);
	});
});

describe('the repository routes against GitHub', () => {
	async function started(h: Awaited<ReturnType<typeof ready>>) {
		const reply = await post(connect, ROUTE, BASE, { provider: 'github' });
		const start = connectStartSchema.parse(reply.json);
		if (start.kind !== 'redirect') throw new Error('expected a redirect');
		return { url: new URL(start.url), h };
	}

	it('starts an install and finishes it for an installation the person can reach', async () => {
		const h = await ready({}, githubReply([42]));
		const { url } = await started(h);
		expect(url.origin + url.pathname).toBe(
			'https://github.com/apps/drupflare/installations/new'
		);
		const state = url.searchParams.get('state') ?? '';
		const done = await post(complete, `${ROUTE}/complete`, `${BASE}/complete`, {
			provider: 'github',
			state,
			code: 'user-code',
			installationId: '42'
		});
		expect(done.status).toBe(201);
		expect(connectionViewSchema.parse(done.json)).toMatchObject({
			provider: 'github',
			state: 'active'
		});
		expect([...h.connections.values()][0]?.externalId).toBe('42');
		const again = await post(complete, `${ROUTE}/complete`, `${BASE}/complete`, {
			provider: 'github',
			state,
			code: 'user-code',
			installationId: '42'
		});
		expect(again.status).toBe(400);
	});

	it('refuses an installation id the person cannot reach, and stores nothing', async () => {
		const h = await ready({}, githubReply([7]));
		const { url } = await started(h);
		const done = await post(complete, `${ROUTE}/complete`, `${BASE}/complete`, {
			provider: 'github',
			state: url.searchParams.get('state'),
			code: 'user-code',
			installationId: '42'
		});
		expect(done.status).toBe(400);
		expect(h.connections.size).toBe(0);
	});

	it('answers 501 for GitHub, and nothing else, while the app has no secrets', async () => {
		const h = await ready();
		h.deps.github = null;
		const github = await post(connect, ROUTE, BASE, { provider: 'github' });
		expect(github.status).toBe(501);
		const token = await post(connect, ROUTE, BASE, GIT);
		expect(token.status).toBe(200);
	});
});
