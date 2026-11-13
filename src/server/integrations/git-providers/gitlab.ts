import { z } from 'zod';
import { timingSafeEqual } from '../../services/crypto';
import { ProviderError, type ProviderFetch, type PushEvent, type RepoSummary } from './index';

const BASE = 'https://gitlab.com';

export interface GitLabApp {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	webhookSecret: string;
	fetch: ProviderFetch;
}

// unverified: the scope names were not read from the OAuth scopes page
export const SCOPES = 'read_api read_repository';

export function authorizeUrl(app: GitLabApp, state: string): string {
	const query = new URLSearchParams({
		client_id: app.clientId,
		redirect_uri: app.redirectUri,
		response_type: 'code',
		state,
		scope: SCOPES
	});
	return `${BASE}/oauth/authorize?${query.toString()}`;
}

const tokenBody = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	expires_in: z.number().int().positive()
});

async function postToken(app: GitLabApp, form: Record<string, string>) {
	const res = await app.fetch(`${BASE}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: app.clientId,
			client_secret: app.clientSecret,
			redirect_uri: app.redirectUri,
			...form
		}).toString()
	});
	const parsed = tokenBody.safeParse(res.ok ? await res.json() : null);
	if (!parsed.success) throw new ProviderError('GitLab did not issue a token');
	return {
		accessToken: parsed.data.access_token,
		refreshToken: parsed.data.refresh_token,
		expiresIn: parsed.data.expires_in
	};
}

export function exchangeCode(app: GitLabApp, code: string) {
	return postToken(app, { grant_type: 'authorization_code', code });
}

// a refresh invalidates the refresh token it used, so the caller has to store the one returned
export function refreshAccess(app: GitLabApp, refreshToken: string) {
	return postToken(app, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

const projectsBody = z.array(
	z.object({ path_with_namespace: z.string(), default_branch: z.string().nullish() })
);

// first page only; pagination is not built yet
export async function listProjects(app: GitLabApp, accessToken: string): Promise<RepoSummary[]> {
	const res = await app.fetch(`${BASE}/api/v4/projects?membership=true&per_page=100`, {
		headers: { authorization: `Bearer ${accessToken}` }
	});
	const parsed = projectsBody.safeParse(res.ok ? await res.json() : null);
	if (!parsed.success) throw new ProviderError('GitLab did not list the projects');
	return parsed.data.map((project) => ({
		fullName: project.path_with_namespace,
		defaultBranch: project.default_branch ?? null
	}));
}

// GitLab sends the secret in plain text in X-Gitlab-Token
export function verifyGitLabToken(secret: string, header: string | null): boolean {
	if (header === null || secret === '') return false;
	return timingSafeEqual(header, secret);
}

const pushBody = z.object({
	object_kind: z.literal('push'),
	ref: z.string(),
	checkout_sha: z.string().nullish(),
	project: z.object({ path_with_namespace: z.string() })
});

export function parseGitLabPush(
	eventName: string | null,
	deliveryId: string,
	body: unknown
): PushEvent | null {
	if (eventName !== 'Push Hook') return null;
	const parsed = pushBody.safeParse(body);
	if (!parsed.success) return null;
	const { ref, checkout_sha, project } = parsed.data;
	if (!ref.startsWith('refs/heads/') || !checkout_sha) return null;
	return {
		repo: project.path_with_namespace,
		branch: ref.slice('refs/heads/'.length),
		sha: checkout_sha,
		installationId: null,
		deliveryId
	};
}
