import { describe, expect, it } from 'vitest';
import {
	ProviderError,
	type ProviderFetch
} from '../../../../src/server/integrations/git-providers';
import { listTokenRepos } from '../../../../src/server/integrations/git-providers/generic';
import {
	guardedProviderFetch,
	publicHost
} from '../../../../src/server/integrations/git-providers/guard';

// the same shape the url-guard spec uses: a fake fetch and a resolver backed by a map
const DNS: Record<string, string[]> = {
	'git.example.org': ['93.184.216.34'],
	'loop.example.org': ['127.0.0.1'],
	'meta.example.org': ['169.254.169.254'],
	'lan.example.org': ['10.0.0.5'],
	'redirect.example.org': ['93.184.216.35']
};
const resolve = async (hostname: string): Promise<string[]> => DNS[hostname] ?? [];

function recorder(reply: (url: string) => Response) {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetch: ProviderFetch = async (url, init) => {
		calls.push({ url, init });
		return reply(url);
	};
	return { fetch, calls };
}

const json = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});

async function refusal(work: () => Promise<unknown>): Promise<string> {
	try {
		await work();
	} catch (error) {
		if (error instanceof ProviderError) return error.message;
		throw error;
	}
	throw new Error('expected a refusal');
}

describe('publicHost', () => {
	it('refuses plain http, an IP literal, and names that resolve to a private or metadata address', async () => {
		for (const input of [
			'http://git.example.org/',
			'https://93.184.216.34/',
			'https://loop.example.org/',
			'https://meta.example.org/',
			'https://lan.example.org/'
		]) {
			await refusal(() => publicHost(input, resolve));
		}
		expect(await refusal(() => publicHost('http://git.example.org/', resolve))).toBe(
			'The host address must be a public https name'
		);
		expect(await refusal(() => publicHost('https://meta.example.org/', resolve))).toBe(
			'The host resolves to a private address, so it was refused'
		);
	});

	it('accepts a public https name and returns the checked URL', async () => {
		const url = await publicHost('https://git.example.org/', resolve);
		expect(url.host).toBe('git.example.org');
	});

	it('refuses a name with no answer', async () => {
		expect(await refusal(() => publicHost('https://nowhere.example.org/', resolve))).toBe(
			'The host name could not be resolved'
		);
	});
});

describe('guardedProviderFetch', () => {
	it('sends the authorization header through on an allowed name', async () => {
		const { fetch, calls } = recorder(() => json([]));
		const guarded = guardedProviderFetch({ fetch, resolve });
		await guarded('https://git.example.org/api/v1/user/repos', {
			headers: { authorization: 'token t0k' }
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.init?.redirect).toBe('manual');
		expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('token t0k');
	});

	it('refuses each bad host before the raw fetch runs, so no token leaves', async () => {
		const { fetch, calls } = recorder(() => json([]));
		const guarded = guardedProviderFetch({ fetch, resolve });
		for (const input of [
			'http://git.example.org/',
			'https://93.184.216.34/',
			'https://loop.example.org/',
			'https://meta.example.org/'
		]) {
			await refusal(() => guarded(input, { headers: { authorization: 'token t0k' } }));
		}
		expect(calls).toHaveLength(0);
	});

	it('refuses a redirect and never requests the private target', async () => {
		const { fetch, calls } = recorder(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: 'https://meta.example.org/' }
				})
		);
		const guarded = guardedProviderFetch({ fetch, resolve });
		expect(
			await refusal(() =>
				guarded('https://redirect.example.org/', { headers: { authorization: 'x' } })
			)
		).toBe('The host redirected the request, so it was refused');
		expect(calls.map((call) => call.url)).toEqual(['https://redirect.example.org/']);
	});

	it('refuses a redirect without a location as well', async () => {
		const { fetch } = recorder(() => new Response(null, { status: 301 }));
		const guarded = guardedProviderFetch({ fetch, resolve });
		await refusal(() => guarded('https://git.example.org/', {}));
	});
});

describe('listTokenRepos through the guard', () => {
	it('lists a Gitea host on an allowed public name', async () => {
		const { fetch } = recorder(() => json([{ full_name: 'ops/site', default_branch: 'main' }]));
		const repos = await listTokenRepos(
			guardedProviderFetch({ fetch, resolve }),
			'gitea',
			'https://git.example.org',
			'tok'
		);
		expect(repos).toEqual([{ fullName: 'ops/site', defaultBranch: 'main' }]);
	});

	it('refuses a Forgejo base URL on loopback before any request', async () => {
		const { fetch, calls } = recorder(() => json([]));
		const base = 'https://loop.example.org';
		await refusal(() =>
			listTokenRepos(guardedProviderFetch({ fetch, resolve }), 'forgejo', base, 'tok')
		);
		expect(calls).toHaveLength(0);
	});
});
