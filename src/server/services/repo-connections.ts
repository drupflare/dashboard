import { sha256Hex } from '@contracts/common';
import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	decryptRecordText,
	encryptRecord,
	type Aad,
	type KeyRing
} from '../../shared/custody/envelope';
import { ApiError } from '../../shared/errors';
import { repoStateFor } from '../../shared/oauth';
import { pullRefusalReason } from '../../shared/operation-copy';
import type { ConnectionView, RemoteView } from '../../shared/repo-connections';
import type { StoredOperation } from '../db/repos/operations';
import type { ConnectionRow, RemoteRow } from '../db/repos/repo-connections';
import * as repo from '../db/repos/repo-connections';
import {
	ProviderError,
	type ProviderFetch,
	type ProviderId,
	type PushEvent,
	type RepoSummary
} from '../integrations/git-providers';
import { listTokenRepos, type TokenProvider } from '../integrations/git-providers/generic';
import {
	exchangeUserCode,
	listInstallationRepos,
	mintInstallationToken,
	parseGitHubPush,
	userInstallationIds,
	verifyGitHubSignature,
	type GitHubApp
} from '../integrations/git-providers/github';
import {
	authorizeUrl,
	exchangeCode,
	listProjects,
	parseGitLabPush,
	refreshAccess,
	SCOPES,
	verifyGitLabToken,
	type GitLabApp
} from '../integrations/git-providers/gitlab';
import { publicHost } from '../integrations/git-providers/guard';
import { randomToken } from './crypto';
import type { OnceStore } from './single-use';

export const SYNC_FLOOR_MINUTES = 5;
export const SYNC_DEFAULT_MINUTES = 60;
const SYNC_CEILING_MINUTES = 10_080;
const CONNECT_TTL_MS = 15 * 60 * 1000;
const PURPOSE = 'repo-connection';
const MOUNT_PATH = /^(modules|themes|profiles)(\/[a-z0-9][a-z0-9_-]*)+$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const REPO = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;
const LABEL: Record<ProviderId, string> = {
	github: 'GitHub',
	gitlab: 'GitLab',
	bitbucket: 'Bitbucket',
	gitea: 'Gitea',
	forgejo: 'Forgejo'
};

// #region store

export type PullStatus = 'installed' | 'failed';

export interface PullTrigger {
	key: string;
}

export interface RepoConnectionStore {
	insertConnection(row: ConnectionRow): Promise<void>;
	getConnection(orgId: string, id: string): Promise<ConnectionRow | null>;
	listConnections(orgId: string): Promise<ConnectionRow[]>;
	activeByExternal(provider: ProviderId, externalId: string): Promise<ConnectionRow | null>;
	setCredential(id: string, envelope: string): Promise<boolean>;
	revokeConnection(orgId: string, id: string, now: number): Promise<boolean>;
	insertRemote(row: RemoteRow): Promise<void>;
	listRemotes(orgId: string, siteId: string): Promise<RemoteRow[]>;
	remotesForPush(provider: ProviderId, repo: string, branch: string): Promise<RemoteRow[]>;
	setPull(id: string, status: PullStatus, at: number, reason: string | null): Promise<void>;
	hasDelivery(provider: ProviderId, deliveryId: string): Promise<boolean>;
	recordDelivery(provider: ProviderId, deliveryId: string, now: number): Promise<void>;
}

export function collegeRepoStore(getDb: () => Promise<CollegeDBClient>): RepoConnectionStore {
	return {
		async insertConnection(row) {
			await repo.insertConnection(await getDb(), row);
		},
		async getConnection(orgId, id) {
			return repo.getConnection(await getDb(), orgId, id);
		},
		async listConnections(orgId) {
			return repo.listConnections(await getDb(), orgId);
		},
		async activeByExternal(provider, externalId) {
			return repo.activeConnectionByExternal(await getDb(), provider, externalId);
		},
		async setCredential(id, envelope) {
			return repo.setConnectionCredential(await getDb(), id, envelope);
		},
		async revokeConnection(orgId, id, now) {
			return repo.revokeConnectionRow(await getDb(), orgId, id, now);
		},
		async insertRemote(row) {
			await repo.insertRemote(await getDb(), row);
		},
		async listRemotes(orgId, siteId) {
			return repo.listRemotes(await getDb(), orgId, siteId);
		},
		async remotesForPush(provider, name, branch) {
			return repo.listRemotesForPush(await getDb(), provider, name, branch);
		},
		async setPull(id, status, at, reason) {
			await repo.setRemotePull(await getDb(), id, status, at, reason);
		},
		async hasDelivery(provider, deliveryId) {
			return repo.hasDelivery(await getDb(), provider, deliveryId);
		},
		async recordDelivery(provider, deliveryId, now) {
			await repo.recordDelivery(await getDb(), provider, deliveryId, now);
		}
	};
}

// #endregion

// #region deps

export interface RepoConnectionDeps {
	store: RepoConnectionStore;
	once: OnceStore;
	// loads on first use, so a missing key answers 501 on the routes that seal a credential
	ring: () => Promise<KeyRing>;
	// every provider call goes through the guard in integrations/git-providers/guard.ts
	fetch: ProviderFetch;
	// resolver for the host check that runs before a token is sent
	resolve: (hostname: string) => Promise<string[]>;
	now: () => number;
	github: Omit<GitHubApp, 'fetch' | 'now'> | null;
	gitlab: Omit<GitLabApp, 'fetch'> | null;
	// starts a git.pull operation and returns it; the key makes a repeat return the same one
	pullRemote: (remote: RemoteRow, trigger: PullTrigger) => Promise<StoredOperation>;
	audit: (orgId: string, action: string, targetId: string) => Promise<void>;
}

let installed: RepoConnectionDeps | null = null;

export function setRepoConnectionDeps(deps: RepoConnectionDeps | null): void {
	installed = deps;
}

export function repoConnectionDeps(): RepoConnectionDeps {
	if (installed === null) {
		throw new ApiError('not_built', 'Repository connections are not available yet');
	}
	return installed;
}

// #endregion

// #region views

export type { ConnectionView, RemoteView };

function connectionView(row: ConnectionRow): ConnectionView {
	return {
		id: row.id,
		provider: row.provider,
		displayName: row.displayName,
		scopes: row.scopes,
		state: row.state,
		createdAt: row.createdAt
	};
}

function remoteView(row: RemoteRow): RemoteView {
	return {
		id: row.id,
		siteId: row.siteId,
		connectionId: row.connectionId,
		repo: row.repoFullName,
		branch: row.branch,
		mountPath: row.mountPath,
		intervalMinutes: row.intervalMinutes,
		lastPullStatus:
			row.lastPullStatus === 'installed' || row.lastPullStatus === 'failed'
				? row.lastPullStatus
				: null,
		lastPullAt: row.lastPullAt,
		lastPullReason: row.lastPullReason,
		createdAt: row.createdAt
	};
}

// #endregion

// #region helpers

// the sealed value is bound to its connection, so a copied envelope fails to open on another row
function aadOf(connectionId: string): Aad {
	return { siteId: connectionId, purpose: PURPOSE };
}

async function seal(
	deps: RepoConnectionDeps,
	connectionId: string,
	plaintext: string
): Promise<string> {
	return JSON.stringify(await encryptRecord(plaintext, aadOf(connectionId), await deps.ring()));
}

async function open(deps: RepoConnectionDeps, row: ConnectionRow): Promise<string> {
	if (row.credentialEnvelope === null) {
		throw new ApiError('conflict', 'This connection holds no stored credential', {
			reason: 'no_credential'
		});
	}
	return decryptRecordText(JSON.parse(row.credentialEnvelope), aadOf(row.id), await deps.ring());
}

function githubOf(deps: RepoConnectionDeps): GitHubApp {
	if (deps.github === null) {
		throw new ApiError('not_built', 'GitHub connections are not available yet');
	}
	return { ...deps.github, fetch: deps.fetch, now: deps.now };
}

function gitlabOf(deps: RepoConnectionDeps): GitLabApp {
	if (deps.gitlab === null) {
		throw new ApiError('not_built', 'GitLab connections are not available yet');
	}
	return { ...deps.gitlab, fetch: deps.fetch };
}

// provider and guard messages are written for owners, so they pass through unchanged
async function refused<T>(
	work: () => Promise<T>,
	code: 'validation' | 'unprocessable'
): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof ProviderError) throw new ApiError(code, error.message);
		throw error;
	}
}

async function requireActive(
	deps: RepoConnectionDeps,
	orgId: string,
	id: string
): Promise<ConnectionRow> {
	const row = await deps.store.getConnection(orgId, id);
	if (row === null) throw new ApiError('not_found', 'Not found');
	if (row.state !== 'active') {
		throw new ApiError('unprocessable', 'This connection was revoked', {
			reason: 'connection_revoked'
		});
	}
	return row;
}

// #endregion

// #region connect

export type ConnectStart =
	{ kind: 'redirect'; url: string } | { kind: 'connected'; connection: ConnectionView };

export interface StartConnectInput {
	orgId: string;
	provider: ProviderId;
	token?: string;
	baseUrl?: string;
}

// the state is single-use and names the org, so a callback cannot attach a connection to another org
export async function startConnect(
	deps: RepoConnectionDeps,
	input: StartConnectInput
): Promise<ConnectStart> {
	if (input.provider === 'github') {
		const app = githubOf(deps);
		const state = await putState(deps, input.orgId, 'github');
		// unverified: the installations/new URL with a state parameter was not read from the GitHub docs
		const slug = encodeURIComponent(app.slug);
		return {
			kind: 'redirect',
			url: `https://github.com/apps/${slug}/installations/new?state=${state}`
		};
	}
	if (input.provider === 'gitlab') {
		const app = gitlabOf(deps);
		const state = await putState(deps, input.orgId, 'gitlab');
		return { kind: 'redirect', url: authorizeUrl(app, state) };
	}
	return connectToken(deps, input.orgId, input.provider, input.token, input.baseUrl);
}

async function putState(
	deps: RepoConnectionDeps,
	orgId: string,
	provider: 'github' | 'gitlab'
): Promise<string> {
	const state = repoStateFor(provider, randomToken(24), orgId);
	await deps.once.put(
		`repo-connect:${state}`,
		JSON.stringify({ orgId, provider }),
		deps.now() + CONNECT_TTL_MS
	);
	return state;
}

async function connectToken(
	deps: RepoConnectionDeps,
	orgId: string,
	provider: TokenProvider,
	token: string | undefined,
	baseUrl: string | undefined
): Promise<ConnectStart> {
	const secret = (token ?? '').trim();
	if (secret === '') throw new ApiError('validation', 'A token is required for this provider');
	let host = 'bitbucket.org';
	if (provider !== 'bitbucket') {
		if (!baseUrl)
			throw new ApiError('validation', 'A host address is required for this provider');
		host = await refused(
			async () => (await publicHost(baseUrl, deps.resolve)).host,
			'validation'
		);
	}
	// the host is checked before the token is sent, and the guarded fetch checks it again on the call
	await refused(
		() => listTokenRepos(deps.fetch, provider, `https://${host}`, secret),
		'validation'
	);
	const id = crypto.randomUUID();
	const row: ConnectionRow = {
		id,
		organizationId: orgId,
		provider,
		externalId: host,
		displayName: `${LABEL[provider]} ${host}`,
		credentialEnvelope: await seal(deps, id, secret),
		scopes: [],
		state: 'active',
		createdAt: deps.now(),
		revokedAt: null
	};
	await deps.store.insertConnection(row);
	await deps.audit(orgId, 'repo.connection.connect', id);
	return { kind: 'connected', connection: connectionView(row) };
}

export interface CompleteConnectInput {
	orgId: string;
	provider: ProviderId;
	state?: string;
	installationId?: string;
	code?: string;
}

export async function completeConnect(
	deps: RepoConnectionDeps,
	input: CompleteConnectInput
): Promise<ConnectionView> {
	if (input.provider !== 'github' && input.provider !== 'gitlab') {
		throw new ApiError('not_found', 'Not found');
	}
	const stored = input.state
		? await deps.once.take(`repo-connect:${input.state}`, deps.now())
		: null;
	const expected = stored
		? (JSON.parse(stored) as { orgId?: unknown; provider?: unknown })
		: null;
	if (expected?.orgId !== input.orgId || expected?.provider !== input.provider) {
		throw new ApiError('validation', 'This connection link has expired or was already used');
	}
	const id = crypto.randomUUID();
	let row: ConnectionRow;
	if (input.provider === 'github') {
		if (!input.installationId || !/^[0-9]+$/.test(input.installationId)) {
			throw new ApiError('validation', 'GitHub did not return an installation');
		}
		if (!input.code)
			throw new ApiError('validation', 'GitHub did not return an authorization code');
		// the callback's installation id is a query parameter anyone can edit, so the signed-in user must own it
		const app = githubOf(deps);
		const code = input.code;
		const reachable = await refused(
			async () => userInstallationIds(app, await exchangeUserCode(app, code)),
			'validation'
		);
		if (!reachable.includes(input.installationId)) {
			throw new ApiError('validation', 'This GitHub installation is not on your account');
		}
		if ((await deps.store.activeByExternal('github', input.installationId)) !== null) {
			throw new ApiError('validation', 'This GitHub installation is already connected');
		}
		row = {
			id,
			organizationId: input.orgId,
			provider: 'github',
			externalId: input.installationId,
			displayName: `GitHub installation ${input.installationId}`,
			credentialEnvelope: null,
			scopes: [],
			state: 'active',
			createdAt: deps.now(),
			revokedAt: null
		};
	} else {
		if (!input.code)
			throw new ApiError('validation', 'GitLab did not return an authorization code');
		const code = input.code;
		const tokens = await refused(() => exchangeCode(gitlabOf(deps), code), 'validation');
		row = {
			id,
			organizationId: input.orgId,
			provider: 'gitlab',
			externalId: 'gitlab.com',
			displayName: 'GitLab gitlab.com',
			credentialEnvelope: await seal(deps, id, tokens.refreshToken),
			scopes: SCOPES.split(' '),
			state: 'active',
			createdAt: deps.now(),
			revokedAt: null
		};
	}
	await deps.store.insertConnection(row);
	await deps.audit(input.orgId, 'repo.connection.connect', id);
	return connectionView(row);
}

// #endregion

// #region connections

export async function listConnections(
	deps: RepoConnectionDeps,
	orgId: string
): Promise<ConnectionView[]> {
	return (await deps.store.listConnections(orgId)).map(connectionView);
}

// revoking clears the stored credential in the same write; a second revoke answers the same view
export async function revokeConnection(
	deps: RepoConnectionDeps,
	orgId: string,
	id: string
): Promise<ConnectionView> {
	const row = await deps.store.getConnection(orgId, id);
	if (row === null) throw new ApiError('not_found', 'Not found');
	if (row.state === 'active') {
		await deps.store.revokeConnection(orgId, id, deps.now());
		await deps.audit(orgId, 'repo.connection.revoke', id);
	}
	return connectionView({ ...row, state: 'revoked', credentialEnvelope: null });
}

export async function listRepositories(
	deps: RepoConnectionDeps,
	orgId: string,
	id: string
): Promise<RepoSummary[]> {
	const row = await requireActive(deps, orgId, id);
	if (row.provider === 'github') {
		const app = githubOf(deps);
		return refused(async () => {
			const { token } = await mintInstallationToken(app, row.externalId);
			return listInstallationRepos(app, token);
		}, 'unprocessable');
	}
	if (row.provider === 'gitlab') {
		const app = gitlabOf(deps);
		return refused(async () => {
			const tokens = await refreshAccess(app, await open(deps, row));
			// a refresh rotates the refresh token, so the new one replaces the stored one
			await deps.store.setCredential(row.id, await seal(deps, row.id, tokens.refreshToken));
			return listProjects(app, tokens.accessToken);
		}, 'unprocessable');
	}
	const token = await open(deps, row);
	const base =
		row.provider === 'bitbucket' ? 'https://bitbucket.org' : `https://${row.externalId}`;
	return refused(
		() => listTokenRepos(deps.fetch, row.provider as TokenProvider, base, token),
		'unprocessable'
	);
}

// #endregion

// #region remotes

export interface AttachInput {
	orgId: string;
	siteId: string;
	connectionId: string;
	repo: string;
	branch: string;
	mountPath: string;
	intervalMinutes?: number;
}

export async function attachRemote(
	deps: RepoConnectionDeps,
	input: AttachInput
): Promise<RemoteView> {
	await requireActive(deps, input.orgId, input.connectionId);
	const name = input.repo.trim();
	if (!REPO.test(name)) throw new ApiError('validation', 'Name the repository as owner/name');
	if (!BRANCH.test(input.branch))
		throw new ApiError('validation', 'The branch name is not valid');
	if (!MOUNT_PATH.test(input.mountPath)) {
		throw new ApiError(
			'validation',
			'The mount path must be inside modules, themes or profiles'
		);
	}
	const interval = input.intervalMinutes ?? SYNC_DEFAULT_MINUTES;
	if (
		!Number.isInteger(interval) ||
		interval < SYNC_FLOOR_MINUTES ||
		interval > SYNC_CEILING_MINUTES
	) {
		throw new ApiError(
			'validation',
			`The interval must be from ${SYNC_FLOOR_MINUTES} to ${SYNC_CEILING_MINUTES} minutes`
		);
	}
	const row: RemoteRow = {
		id: crypto.randomUUID(),
		siteId: input.siteId,
		organizationId: input.orgId,
		connectionId: input.connectionId,
		repoFullName: name,
		branch: input.branch,
		mountPath: input.mountPath,
		intervalMinutes: interval,
		lastPullStatus: null,
		lastPullAt: null,
		lastPullReason: null,
		createdAt: deps.now()
	};
	await deps.store.insertRemote(row);
	return remoteView(row);
}

export async function listRemotes(
	deps: RepoConnectionDeps,
	orgId: string,
	siteId: string
): Promise<RemoteView[]> {
	return (await deps.store.listRemotes(orgId, siteId)).map(remoteView);
}

// #endregion

// #region webhooks

export interface DeliveryInput {
	eventName: string | null;
	deliveryId: string;
	rawBody: string;
	// X-Hub-Signature-256 for GitHub, X-Gitlab-Token for GitLab
	signature: string | null;
}

export interface DeliveryResult {
	duplicate: boolean;
	matched: number;
}

// the signature is checked before the body is read; a redelivery answers without pulling again
export async function acceptDelivery(
	deps: RepoConnectionDeps,
	provider: 'github' | 'gitlab',
	input: DeliveryInput
): Promise<DeliveryResult> {
	const secret =
		provider === 'github' ? githubOf(deps).webhookSecret : gitlabOf(deps).webhookSecret;
	const verified =
		provider === 'github'
			? await verifyGitHubSignature(secret, input.rawBody, input.signature)
			: verifyGitLabToken(secret, input.signature);
	if (!verified) throw new ApiError('unauthenticated', 'The webhook signature is not valid');
	if (input.deliveryId === '') throw new ApiError('validation', 'The delivery id is missing');
	if (await deps.store.hasDelivery(provider, input.deliveryId)) {
		return { duplicate: true, matched: 0 };
	}
	let body: unknown = null;
	try {
		body = JSON.parse(input.rawBody);
	} catch {
		body = null;
	}
	const event =
		provider === 'github'
			? parseGitHubPush(input.eventName, input.deliveryId, body)
			: parseGitLabPush(input.eventName, input.deliveryId, body);
	if (event === null) {
		await deps.store.recordDelivery(provider, input.deliveryId, deps.now());
		return { duplicate: false, matched: 0 };
	}
	return handlePush(deps, provider, event);
}

// the owner pressed pull; the Idempotency-Key makes a second press return the same operation
export async function pullNow(
	deps: RepoConnectionDeps,
	input: { orgId: string; siteId: string; remoteId: string; idempotencyKey: string }
): Promise<StoredOperation> {
	const remote = (await deps.store.listRemotes(input.orgId, input.siteId)).find(
		(row) => row.id === input.remoteId
	);
	if (remote === undefined) throw new ApiError('not_found', 'Not found');
	await requireActive(deps, input.orgId, remote.connectionId);
	return deps.pullRemote(remote, { key: input.idempotencyKey });
}

// one git.pull operation per matching remote; the workflow writes the result on the remote, and a
// pull that cannot start is stored there as failed without failing the delivery
export async function handlePush(
	deps: RepoConnectionDeps,
	provider: ProviderId,
	event: PushEvent
): Promise<DeliveryResult> {
	const remotes = await deps.store.remotesForPush(provider, event.repo, event.branch);
	let matched = 0;
	for (const remote of remotes) {
		const connection = await deps.store.getConnection(
			remote.organizationId,
			remote.connectionId
		);
		if (connection === null) continue;
		// a GitHub installation id must match, so a same-named repo on another installation is not pulled
		if (provider === 'github' && connection.externalId !== event.installationId) continue;
		matched++;
		// the delivery id and the remote make the key, so a redelivery returns the same operation
		const key = `git-pull:${await sha256Hex(`${provider}:${event.deliveryId}:${remote.id}`)}`;
		try {
			await deps.pullRemote(remote, { key });
		} catch (error) {
			const reason =
				error instanceof ApiError
					? pullRefusalReason(error)
					: 'The pull could not be started. Press Pull to try again.';
			await deps.store.setPull(remote.id, 'failed', deps.now(), reason);
		}
	}
	await deps.store.recordDelivery(provider, event.deliveryId, deps.now());
	return { duplicate: false, matched };
}

// #endregion
