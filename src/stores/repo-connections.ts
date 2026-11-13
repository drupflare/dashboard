import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { ConnectionView, ProviderId, RemoteView } from '~/shared/repo-connections';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
	github: 'GitHub',
	gitlab: 'GitLab',
	bitbucket: 'Bitbucket',
	gitea: 'Gitea',
	forgejo: 'Forgejo'
};

export type RepoSummary = { fullName: string; defaultBranch: string | null };

export type ConnectStart =
	{ kind: 'redirect'; url: string } | { kind: 'connected'; connection: ConnectionView };

export type RemoteInput = {
	connectionId: string;
	repo: string;
	branch: string;
	mountPath: string;
	intervalMinutes?: number;
};

const orgPath = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/repo-connections`;
const segment = (value: string) => encodeURIComponent(value);

export const useRepoConnectionsStore = defineStore('repoConnections', {
	state: () => ({
		// keyed by organization id; undefined: not loaded; an array (possibly empty): loaded; null: the organization is not found
		connections: new Map<string, ConnectionView[] | null>(),
		connectionsError: null as ApiClientError | null,
		// keyed by connection id; undefined: not loaded
		repositories: new Map<string, RepoSummary[]>(),
		// keyed by site id; undefined: not loaded; an array (possibly empty): loaded; null: the site is not found
		remotes: new Map<string, RemoteView[] | null>(),
		remotesError: null as ApiClientError | null
	}),
	actions: {
		async loadConnections(orgId: string): Promise<void> {
			if (this.connections.has(orgId)) return;
			this.connectionsError = null;
			try {
				const page = await useApi().get<{ items: ConnectionView[] }>(orgPath(orgId));
				this.connections.set(orgId, page.items);
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 404) this.connections.set(orgId, null);
				else this.connectionsError = failure;
			}
		},
		async reloadConnections(orgId: string): Promise<void> {
			this.connections.delete(orgId);
			await this.loadConnections(orgId);
		},
		// a failure is thrown, not kept, so the caller can show it beside the picker
		async loadRepositories(orgId: string, connectionId: string): Promise<RepoSummary[]> {
			const cached = this.repositories.get(connectionId);
			if (cached) return cached;
			const page = await useApi().get<{ items: RepoSummary[] }>(
				`${orgPath(orgId)}/${segment(connectionId)}/repositories`
			);
			this.repositories.set(connectionId, page.items);
			return page.items;
		},
		startConnect(orgId: string, provider: ProviderId): Promise<ConnectStart> {
			return useApi().post<ConnectStart>(orgPath(orgId), { provider });
		},
		async revoke(orgId: string, connectionId: string): Promise<void> {
			const connection = await useApi().post<ConnectionView>(
				`${orgPath(orgId)}/${segment(connectionId)}/revoke`,
				{}
			);
			const list = this.connections.get(orgId);
			const at = list?.findIndex((item) => item.id === connectionId) ?? -1;
			if (list && at >= 0) list[at] = connection;
		},
		async loadRemotes(orgId: string, siteId: string): Promise<void> {
			if (this.remotes.has(siteId)) return;
			this.remotesError = null;
			try {
				const page = await useApi().get<{ items: RemoteView[] }>(
					`/orgs/${segment(orgId)}/sites/${segment(siteId)}/remotes`
				);
				this.remotes.set(siteId, page.items);
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 404) this.remotes.set(siteId, null);
				else this.remotesError = failure;
			}
		},
		async attachRemote(orgId: string, siteId: string, input: RemoteInput): Promise<RemoteView> {
			const remote = await useApi().post<RemoteView>(
				`/orgs/${segment(orgId)}/sites/${segment(siteId)}/remotes`,
				{ ...input }
			);
			const list = this.remotes.get(siteId);
			if (list) list.push(remote);
			return remote;
		},
		reset(): void {
			this.connections.clear();
			this.connectionsError = null;
			this.repositories.clear();
			this.remotes.clear();
			this.remotesError = null;
		}
	}
});
