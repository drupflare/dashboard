export const PROVIDER_IDS = ['github', 'gitlab', 'bitbucket', 'gitea', 'forgejo'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

// every provider call goes through this, so tests pass a fake and nothing reaches a real host
export type ProviderFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface RepoSummary {
	fullName: string;
	defaultBranch: string | null;
}

export interface PushEvent {
	repo: string;
	branch: string;
	sha: string;
	installationId: string | null;
	deliveryId: string;
}

export class ProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProviderError';
	}
}
