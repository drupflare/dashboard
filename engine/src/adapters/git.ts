import type { D1Database } from '@cloudflare/workers-types';
import { GitError, parsePull, parseRemoteList, refusalOf, type RemoteRecord } from '../git-parts';
import type { GitTokenPull, GitWorker, RemoteLedger } from '../ports';
import { SiteAnswered, siteFetcher } from './site';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// a refusal of the token is never retried: the site counts failures against one budget
function refusedToken(status: number): void {
	if (status === 401 || status === 403) {
		throw new GitError('owner_token_rejected', 'the site refused the owner token');
	}
}

// the released site's /git routes; every call carries the owner token in a header and nothing in
// the query but the action and the site's own remote id
export function gitWorkerOf(fetcher: typeof fetch, timeoutMs: number): GitWorker {
	const fetchSite = siteFetcher(fetcher, timeoutMs);
	return {
		async remotes(hostname, auth) {
			const { status, text } = await fetchSite(
				hostname,
				'/git?action=list',
				{ method: 'GET', headers: bearer(auth.bearer) },
				(code) => code === 200
			);
			refusedToken(status);
			if (status !== 200) throw new SiteAnswered(hostname, '/git', status);
			return parseRemoteList(text);
		},

		async pull(hostname, remoteId, auth) {
			const path = `/git?action=pull&id=${encodeURIComponent(remoteId)}`;
			const { status, text } = await fetchSite(
				hostname,
				path,
				{ method: 'GET', headers: bearer(auth.bearer) },
				(code) => code < 500
			);
			refusedToken(status);
			if (status >= 500 || status === 408 || status === 425 || status === 429) {
				throw new SiteAnswered(hostname, '/git', status);
			}
			if (status >= 400) {
				let error: string | null = null;
				try {
					error = (JSON.parse(text ?? '') as { error?: string }).error ?? null;
				} catch {
					error = null;
				}
				throw refusalOf({ error });
			}
			return parsePull(text);
		}
	};
}

// the released site takes a provider token only in the query of an add, which would put a
// credential in a URL; this refuses until the site can take one for a single call
export const unavailableTokenPull: GitTokenPull = {
	async pull() {
		throw new GitError(
			'remote_not_on_site',
			'the site cannot take a repository token for one call yet, so it cannot follow a repository it was not given'
		);
	}
};

interface RemoteDbRow {
	id: string;
	organization_id: string;
	site_id: string;
	provider: string;
	repo_full_name: string;
	branch: string;
	mount_path: string;
}

export class D1RemoteLedger implements RemoteLedger {
	constructor(private readonly db: D1Database) {}

	async get(organizationId: string, siteId: string, id: string): Promise<RemoteRecord | null> {
		const row = await this.db
			.prepare(
				`SELECT r.id, r.organization_id, r.site_id, c.provider, r.repo_full_name, r.branch,
				r.mount_path
				FROM site_remotes r JOIN repo_connections c ON c.id = r.connection_id
				WHERE r.id = ? AND r.organization_id = ? AND r.site_id = ?`
			)
			.bind(id, organizationId, siteId)
			.first<RemoteDbRow>();
		if (row === null) return null;
		return {
			id: row.id,
			organizationId: row.organization_id,
			siteId: row.site_id,
			provider: row.provider,
			repo: row.repo_full_name,
			branch: row.branch,
			mountPath: row.mount_path
		};
	}

	async record(
		id: string,
		result: { status: 'installed' | 'failed'; at: number; reason: string | null }
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE site_remotes SET last_pull_status = ?, last_pull_at = ?, last_pull_reason = ?
				WHERE id = ?`
			)
			.bind(result.status, result.at, result.reason, id)
			.run();
	}

	async clearPending(id: string): Promise<void> {
		await this.db
			.prepare('UPDATE site_remotes SET pull_pending = 0 WHERE id = ?')
			.bind(id)
			.run();
	}

	async takePending(id: string): Promise<boolean> {
		const { meta } = await this.db
			.prepare('UPDATE site_remotes SET pull_pending = 0 WHERE id = ? AND pull_pending = 1')
			.bind(id)
			.run();
		return meta.changes === 1;
	}
}
