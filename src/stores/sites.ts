import type {
	SITE_STATES,
	SiteCategory,
	SiteConfig,
	SiteKind,
	SitePlane,
	SiteRing
} from '@contracts/sites';
import { defineStore } from 'pinia';
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';

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
		reset(): void {
			this.byId.clear();
			this.lists.clear();
		}
	}
});
