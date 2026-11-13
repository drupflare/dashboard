import { z } from 'zod';
import { PermanentError } from './step';

export const GIT_ERROR_CODES = [
	'owner_token_rejected',
	'remote_not_on_site',
	'remote_mount_differs',
	'remote_gone',
	'no_branch',
	'no_module',
	'path_conflict',
	'rolled_back',
	'pull_refused',
	'answer_unreadable'
] as const;
export type GitErrorCode = (typeof GIT_ERROR_CODES)[number];

// the text is bounded and holds no body, header or token, so it is safe in an operation record
export class GitError extends PermanentError {
	declare readonly code: GitErrorCode;

	constructor(code: GitErrorCode, message: string) {
		super(code, message);
	}
}

export interface GitRemoteSpec {
	provider: string;
	repo: string;
	branch: string;
	mountPath: string;
}

export interface GitSiteRemote {
	id: string;
	provider: string;
	repo: string;
	branch: string;
	mount: string | null;
}

export interface GitPullResult {
	sha: string | null;
	changed: number;
}

// the site's git provider ids; Forgejo speaks the Gitea API
export function siteProviderOf(provider: string): string {
	return provider === 'forgejo' ? 'gitea' : provider;
}

const listAnswer = z.looseObject({
	remotes: z.array(
		z.looseObject({
			id: z.string().min(1),
			provider: z.string(),
			repo: z.string(),
			branch: z.string(),
			mount: z.string().nullish()
		})
	)
});

export function parseRemoteList(text: string | null): GitSiteRemote[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text ?? '');
	} catch {
		throw new GitError('answer_unreadable', 'the list of repositories was not readable');
	}
	const checked = listAnswer.safeParse(parsed);
	if (!checked.success) {
		throw new GitError('answer_unreadable', 'the list of repositories was not readable');
	}
	return checked.data.remotes.map((remote) => ({
		id: remote.id,
		provider: remote.provider,
		repo: remote.repo,
		branch: remote.branch,
		mount: remote.mount ?? null
	}));
}

// the repository the owner attached, as the site names it; repository names ignore case
export function matchRemote(
	remotes: readonly GitSiteRemote[],
	spec: GitRemoteSpec
): GitSiteRemote | null {
	return (
		remotes.find(
			(remote) =>
				remote.provider === siteProviderOf(spec.provider) &&
				remote.repo.toLowerCase() === spec.repo.toLowerCase() &&
				remote.branch === spec.branch
		) ?? null
	);
}

const pullAnswer = z.looseObject({
	ok: z.boolean().optional(),
	applied: z.boolean().optional(),
	rolledBack: z.boolean().optional(),
	sha: z.string().nullish(),
	error: z.string().nullish(),
	counts: z
		.looseObject({
			added: z.number().optional(),
			modified: z.number().optional(),
			removed: z.number().optional()
		})
		.nullish()
});

const REASON_CHARS = 300;

// the site's own words, bounded and without control characters, since they land in an operation record
export function boundedText(text: string | null | undefined): string {
	return (
		(text ?? '')
			// eslint-disable-next-line no-control-regex
			.replace(/[\u0000-\u001f\u007f]+/g, ' ')
			.trim()
			.slice(0, REASON_CHARS)
	);
}

// a refusal the site words in text; the structured fields decide first and the text sorts the rest
export function refusalOf(answer: { rolledBack?: boolean; error?: string | null }): GitError {
	const text = boundedText(answer.error);
	if (answer.rolledBack === true) return new GitError('rolled_back', text);
	if (/carries no mountable module/i.test(text)) return new GitError('no_module', text);
	if (/belong to another remote/i.test(text)) return new GitError('path_conflict', text);
	if (/has no branch/i.test(text)) return new GitError('no_branch', text);
	if (/unknown remote/i.test(text)) return new GitError('remote_gone', text);
	return new GitError('pull_refused', text);
}

export function parsePull(text: string | null): GitPullResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text ?? '');
	} catch {
		throw new GitError('answer_unreadable', 'the pull answer was not readable');
	}
	const checked = pullAnswer.safeParse(parsed);
	if (!checked.success)
		throw new GitError('answer_unreadable', 'the pull answer was not readable');
	const answer = checked.data;
	if (answer.ok !== true || answer.applied !== true || answer.rolledBack === true) {
		throw refusalOf(answer);
	}
	const counts = answer.counts;
	return {
		sha: answer.sha ?? null,
		changed: (counts?.added ?? 0) + (counts?.modified ?? 0) + (counts?.removed ?? 0)
	};
}

export interface RemoteRecord {
	id: string;
	organizationId: string;
	siteId: string;
	provider: string;
	repo: string;
	branch: string;
	mountPath: string;
}

export const PULL_STATUSES = ['installed', 'failed'] as const;
export type PullStatus = (typeof PULL_STATUSES)[number];
