import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { hmacSha256Hex, timingSafeEqual } from '../../services/crypto';
import { ProviderError, type ProviderFetch, type PushEvent, type RepoSummary } from './index';

const API = 'https://api.github.com';
// the REST version the token and repository endpoints were read against
const API_VERSION = '2026-03-10';

export interface GitHubApp {
	appId: string;
	// PKCS#8 PEM; GitHub downloads PKCS#1, which has to be converted before it is stored
	privateKey: string;
	slug: string;
	// the app's OAuth credentials, used to prove which installations the signed-in user can reach
	clientId: string;
	clientSecret: string;
	webhookSecret: string;
	fetch: ProviderFetch;
	now: () => number;
}

const userTokenBody = z.object({ access_token: z.string().min(1) });

// unverified: the token endpoint path and the JSON reply were not read from the GitHub docs
export async function exchangeUserCode(app: GitHubApp, code: string): Promise<string> {
	const res = await app.fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/json' },
		body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code })
	});
	// a failed exchange answers 200 with an error field, so the shape decides
	const parsed = userTokenBody.safeParse(res.ok ? await res.json() : null);
	if (!parsed.success) throw new ProviderError('GitHub did not accept the authorization');
	return parsed.data.access_token;
}

const userInstallationsBody = z.object({
	installations: z.array(z.object({ id: z.number().int() }))
});

// unverified: the path and reply were not read from the GitHub docs; one page of 100, so more than 100 fails closed
export async function userInstallationIds(app: GitHubApp, userToken: string): Promise<string[]> {
	const res = await app.fetch(`${API}/user/installations?per_page=100`, {
		headers: {
			authorization: `Bearer ${userToken}`,
			accept: 'application/vnd.github+json',
			'x-github-api-version': API_VERSION
		}
	});
	const parsed = userInstallationsBody.safeParse(res.ok ? await res.json() : null);
	if (!parsed.success) throw new ProviderError('GitHub did not list your installations');
	return parsed.data.installations.map((installation) => String(installation.id));
}

// GitHub accepts an app JWT that lives at most ten minutes; the issue time sits a minute back for clock skew
export async function appJwt(app: GitHubApp): Promise<string> {
	const key = await importPKCS8(app.privateKey, 'RS256');
	const issued = Math.floor(app.now() / 1000) - 60;
	return new SignJWT({})
		.setProtectedHeader({ alg: 'RS256' })
		.setIssuedAt(issued)
		.setExpirationTime(issued + 600)
		.setIssuer(app.appId)
		.sign(key);
}

const tokenBody = z.object({ token: z.string().min(1), expires_at: z.string() });

export async function mintInstallationToken(
	app: GitHubApp,
	installationId: string
): Promise<{ token: string; expiresAt: string }> {
	const res = await app.fetch(
		`${API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${await appJwt(app)}`,
				accept: 'application/vnd.github+json',
				'x-github-api-version': API_VERSION
			}
		}
	);
	const parsed = tokenBody.safeParse(res.ok ? await res.json() : null);
	if (!parsed.success) throw new ProviderError('GitHub did not issue an access token');
	return { token: parsed.data.token, expiresAt: parsed.data.expires_at };
}

const reposBody = z.object({
	repositories: z.array(z.object({ full_name: z.string(), default_branch: z.string().nullish() }))
});

// unverified: the list endpoint's path and response were not read from its docs page
export async function listInstallationRepos(app: GitHubApp, token: string): Promise<RepoSummary[]> {
	const res = await app.fetch(`${API}/installation/repositories?per_page=100`, {
		headers: {
			authorization: `Bearer ${token}`,
			accept: 'application/vnd.github+json',
			'x-github-api-version': API_VERSION
		}
	});
	const parsed = reposBody.safeParse(res.ok ? await res.json() : null);
	if (!parsed.success) throw new ProviderError('GitHub did not list the repositories');
	return parsed.data.repositories.map((repo) => ({
		fullName: repo.full_name,
		defaultBranch: repo.default_branch ?? null
	}));
}

// the header carries "sha256=" and the hex HMAC-SHA256 of the raw body under the webhook secret
export async function verifyGitHubSignature(
	secret: string,
	rawBody: string,
	header: string | null
): Promise<boolean> {
	if (header === null || secret === '') return false;
	return timingSafeEqual(header, `sha256=${await hmacSha256Hex(secret, rawBody)}`);
}

const pushBody = z.object({
	ref: z.string(),
	after: z.string(),
	repository: z.object({ full_name: z.string() }),
	installation: z.object({ id: z.number().int() }).optional()
});

// only a branch push counts; a tag, or a deleted branch (an all-zero sha), is ignored
export function parseGitHubPush(
	eventName: string | null,
	deliveryId: string,
	body: unknown
): PushEvent | null {
	if (eventName !== 'push') return null;
	const parsed = pushBody.safeParse(body);
	if (!parsed.success) return null;
	const { ref, after, repository, installation } = parsed.data;
	if (!ref.startsWith('refs/heads/') || /^0+$/.test(after)) return null;
	return {
		repo: repository.full_name,
		branch: ref.slice('refs/heads/'.length),
		sha: after,
		installationId: installation ? String(installation.id) : null,
		deliveryId
	};
}
