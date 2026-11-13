import { z } from 'zod';
import { ProviderError, type ProviderFetch, type RepoSummary } from './index';

export type TokenProvider = 'bitbucket' | 'gitea' | 'forgejo';

// unverified: the Gitea, Forgejo and Bitbucket list endpoints and their fields were not read from their docs
const giteaRepos = z.array(
	z.object({ full_name: z.string(), default_branch: z.string().nullish() })
);
const bitbucketRepos = z.object({
	values: z.array(
		z.object({ full_name: z.string(), mainbranch: z.object({ name: z.string() }).nullish() })
	)
});

export async function listTokenRepos(
	fetch: ProviderFetch,
	provider: TokenProvider,
	baseUrl: string,
	token: string
): Promise<RepoSummary[]> {
	if (provider === 'bitbucket') {
		const res = await fetch(
			'https://api.bitbucket.org/2.0/repositories?role=member&pagelen=50',
			{
				headers: { authorization: `Bearer ${token}` }
			}
		);
		const parsed = bitbucketRepos.safeParse(res.ok ? await res.json() : null);
		if (!parsed.success) throw new ProviderError('Bitbucket did not list the repositories');
		return parsed.data.values.map((repo) => ({
			fullName: repo.full_name,
			defaultBranch: repo.mainbranch?.name ?? null
		}));
	}
	const url = new URL('/api/v1/user/repos?limit=50', baseUrl);
	const res = await fetch(url.href, { headers: { authorization: `token ${token}` } });
	const parsed = giteaRepos.safeParse(res.ok ? await res.json() : null);
	if (!parsed.success) throw new ProviderError('The host did not list the repositories');
	return parsed.data.map((repo) => ({
		fullName: repo.full_name,
		defaultBranch: repo.default_branch ?? null
	}));
}
