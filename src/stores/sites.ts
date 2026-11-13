import type { Operation } from '@contracts/operations';
import type {
	AdminPasswordState,
	SITE_STATES,
	SiteCategory,
	SiteConfig,
	SiteKind,
	SitePlane,
	SiteRing
} from '@contracts/sites';
import { defineStore } from 'pinia';
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import { useSessionStore } from '~/stores/session';

export type SiteState = (typeof SITE_STATES)[number];

export interface SiteSummary {
	id: string;
	orgId: string;
	name: string;
	kind: SiteKind;
	category: SiteCategory;
	plane: SitePlane;
	config: SiteConfig;
	accountId: string | null;
	state: SiteState;
	ring: SiteRing;
	primaryHostname: string | null;
	hostnames: string[];
	release?: { current: string | null; available: string | null };
	admin: { username: string | null; email: string | null; password: AdminPasswordState };
	box?: { found: boolean; missingSince: string | null };
	createdAt: string;
	updatedAt: string;
}

interface SitePage {
	items: SiteSummary[];
	nextCursor: string | null;
}

export interface SiteList {
	ids: string[];
	nextCursor: string | null;
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

export const SITE_KIND_LABELS: Record<SiteKind, string> = {
	drupal: 'Drupal',
	nuxtpress: 'Nuxtpress',
	smoke: 'Smoke',
	mylora: 'MyLoRA',
	custom: 'Bring Your Own'
};

export const SITE_PLANE_LABELS: Record<SitePlane, string> = {
	managed: 'Managed',
	'self-managed': 'Self-Managed',
	'self-hosted': 'Self-Hosted'
};

export const useSitesStore = defineStore('sites', {
	state: () => ({
		// keyed by site id; undefined: not loaded; an object: loaded
		byId: new Map<string, SiteSummary | null>(),
		// keyed by organization id; undefined: not loaded
		lists: new Map<string, SiteList>()
	}),
	getters: {
		forOrg:
			(state) =>
			(orgId: string): SiteSummary[] => {
				const list = state.lists.get(orgId);
				if (!list) return [];
				return list.ids.flatMap((id) => {
					const site = state.byId.get(id);
					return site ? [site] : [];
				});
			}
	},
	actions: {
		async load(orgId: string): Promise<void> {
			const existing = this.lists.get(orgId);
			if (existing?.status === 'ready' || existing?.status === 'loading') return;
			this.lists.set(orgId, { ids: [], nextCursor: null, status: 'loading', error: null });
			await this.fetchPage(orgId, null);
		},
		async reload(orgId: string): Promise<void> {
			this.lists.delete(orgId);
			await this.load(orgId);
		},
		async loadMore(orgId: string): Promise<void> {
			const list = this.lists.get(orgId);
			if (!list?.nextCursor || list.status === 'loading') return;
			list.status = 'loading';
			await this.fetchPage(orgId, list.nextCursor);
		},
		async fetchPage(orgId: string, cursor: string | null): Promise<void> {
			try {
				const page = await useApi().get<SitePage>(
					`/orgs/${encodeURIComponent(orgId)}/sites`,
					cursor ? { cursor } : undefined
				);
				const list = this.lists.get(orgId);
				if (!list) return;
				for (const site of page.items) this.byId.set(site.id, site);
				list.ids.push(...page.items.map((site) => site.id));
				list.nextCursor = page.nextCursor;
				list.status = 'ready';
				list.error = null;
			} catch (error) {
				const list = this.lists.get(orgId);
				if (!list) return;
				list.status = 'error';
				list.error = toApiClientError(error);
			}
		},
		// useApi has no header argument, so the Idempotency-Key call goes through $fetch
		async upgrade(orgId: string, siteId: string, idempotencyKey: string): Promise<Operation> {
			const fetcher = $fetch as unknown as (
				url: string,
				options: { method: 'POST'; headers: Record<string, string> }
			) => Promise<Operation>;
			try {
				const operation = await fetcher(
					`/api/v1/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/upgrade`,
					{ method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } }
				);
				// the site's release changes when the operation ends, so the next read is a fresh one
				this.lists.delete(orgId);
				return operation;
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 401) useSessionStore().clear();
				throw failure;
			}
		},
		// the adoption makes a new site, so the list reads fresh once it has started
		async adopt(orgId: string, siteId: string, idempotencyKey: string): Promise<Operation> {
			const fetcher = $fetch as unknown as (
				url: string,
				options: { method: 'POST'; headers: Record<string, string> }
			) => Promise<Operation>;
			try {
				const operation = await fetcher(
					`/api/v1/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/adopt`,
					{ method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } }
				);
				this.lists.delete(orgId);
				return operation;
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 401) useSessionStore().clear();
				throw failure;
			}
		},
		// the delete runs as an operation; the list reads fresh once it has started
		async remove(
			orgId: string,
			siteId: string,
			confirm: string,
			idempotencyKey: string
		): Promise<Operation> {
			const fetcher = $fetch as unknown as (
				url: string,
				options: {
					method: 'POST';
					headers: Record<string, string>;
					body: Record<string, unknown>;
				}
			) => Promise<Operation>;
			try {
				const operation = await fetcher(
					`/api/v1/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/delete`,
					{
						method: 'POST',
						headers: { 'Idempotency-Key': idempotencyKey },
						body: { confirm }
					}
				);
				this.lists.delete(orgId);
				return operation;
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 401) useSessionStore().clear();
				throw failure;
			}
		},
		// only a site found on a box can be renamed; the answer is the site as it now stands
		async rename(orgId: string, siteId: string, name: string): Promise<SiteSummary> {
			const fetcher = $fetch as unknown as (
				url: string,
				options: { method: 'POST'; body: Record<string, unknown> }
			) => Promise<SiteSummary>;
			try {
				const site = await fetcher(
					`/api/v1/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/rename`,
					{ method: 'POST', body: { name } }
				);
				this.byId.set(siteId, site);
				return site;
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 401) useSessionStore().clear();
				throw failure;
			}
		},
		// cleanup removes a half-made site, so the cached row and list are stale
		async cleanup(orgId: string, siteId: string): Promise<Operation> {
			const fetcher = $fetch as unknown as (
				url: string,
				options: { method: 'POST'; headers: Record<string, string> }
			) => Promise<Operation>;
			try {
				const operation = await fetcher(
					`/api/v1/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/cleanup`,
					{ method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() } }
				);
				this.byId.delete(siteId);
				this.lists.delete(orgId);
				return operation;
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 401) useSessionStore().clear();
				throw failure;
			}
		},
		reset(): void {
			this.byId.clear();
			this.lists.clear();
		}
	}
});
