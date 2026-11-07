import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { SiteHealth } from '~/shared/health/view';

export type {
	HealthLeafView,
	HealthNodeView,
	ReadinessView,
	SiteHealth
} from '~/shared/health/view';

const inflight = new Map<string, Promise<SiteHealth | null>>();

export const useHealthStore = defineStore('health', {
	state: () => ({
		// keyed by site id; undefined: not loaded; null: known absent; an object: loaded
		bySite: new Map<string, SiteHealth | null>(),
		// the last failed read of a site; cleared by the next read that works
		errors: new Map<string, ApiClientError>()
	}),
	actions: {
		// a read already in flight is shared, so a page and a checklist never ask twice at once
		fetchOne(orgId: string, siteId: string): Promise<SiteHealth | null> {
			const running = inflight.get(siteId);
			if (running) return running;
			const read = this.read(orgId, siteId).finally(() => inflight.delete(siteId));
			inflight.set(siteId, read);
			return read;
		},
		async read(orgId: string, siteId: string): Promise<SiteHealth | null> {
			try {
				const health = await useApi().get<SiteHealth>(
					`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/health`
				);
				this.bySite.set(siteId, health);
				this.errors.delete(siteId);
				return health;
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 404) {
					this.bySite.set(siteId, null);
					this.errors.delete(siteId);
					return null;
				}
				this.errors.set(siteId, failure);
				throw failure;
			}
		},
		async load(orgId: string, siteId: string): Promise<void> {
			if (this.bySite.has(siteId)) return;
			try {
				await this.fetchOne(orgId, siteId);
			} catch {
				// the failure is kept in errors for the screen to show
			}
		},
		reset(): void {
			this.bySite.clear();
			this.errors.clear();
			inflight.clear();
		}
	}
});
