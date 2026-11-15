import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';

export type RolloutStatus = 'rolling' | 'complete' | 'halted' | 'reverted';
export type RingName = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export interface RolloutRing {
	ring: RingName;
	reached: boolean;
	upgraded: number;
	failed: number;
	reverted: number;
	stuck: number;
}

export interface RolloutView {
	id: string;
	releaseId: string;
	status: RolloutStatus;
	currentRing: RingName | null;
	rings: RolloutRing[];
	reasons: string[];
	stopRequested: boolean;
	firstRingAt: number | null;
	lastRingAt: number | null;
	advisoryIntervalMs: number | null;
	createdAt: number;
}

export interface ReleaseView {
	id: string;
	kind: 'worker' | 'php' | 'drupal-pack';
	version: string;
	schemaVersion: number;
	acceptsSchema: number;
	publishedAt: number;
	advisoryAt: number | null;
	rollout: RolloutView | null;
}

export interface RolloutChoices {
	designations: { synthetic: string[]; own: string[]; canary: string[] };
	overrides: { siteId: string; ring: RingName }[];
}

export interface RollbackCheck {
	siteId: string;
	release: string;
	allowed: boolean;
	reason: string | null;
	offers: ('restore-data-with-code' | 'fix-forward')[];
}

export const useReleasesStore = defineStore('releases', {
	state: () => ({
		// undefined: not loaded; an array: loaded
		releases: undefined as ReleaseView[] | undefined,
		status: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
		error: null as ApiClientError | null
	}),
	actions: {
		async load(): Promise<void> {
			this.status = 'loading';
			this.error = null;
			try {
				const page = await useApi().get<{ releases: ReleaseView[] }>('/admin/releases');
				this.releases = page.releases;
				this.status = 'ready';
			} catch (error) {
				this.error = toApiClientError(error);
				this.status = 'error';
			}
		},
		async register(input: {
			kind: ReleaseView['kind'];
			version: string;
			manifestUrl: string;
			manifestDigest: string;
		}): Promise<void> {
			await useApi().post('/admin/releases', input);
			await this.load();
		},
		async startRollout(
			releaseId: string,
			choices: RolloutChoices,
			idempotencyKey: string
		): Promise<RolloutView> {
			const rollout = await useApi().post<RolloutView>(
				`/admin/releases/${encodeURIComponent(releaseId)}/rollout`,
				choices as unknown as Record<string, unknown>,
				{ 'Idempotency-Key': idempotencyKey }
			);
			await this.load();
			return rollout;
		},
		async stopRollout(releaseId: string, rolloutId: string): Promise<void> {
			await useApi().post(`/admin/releases/${encodeURIComponent(releaseId)}/rollout/stop`, {
				rolloutId
			});
			await this.load();
		},
		rollbackCheck(orgId: string, siteId: string, release: string): Promise<RollbackCheck> {
			return useApi().get<RollbackCheck>(
				`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/rollback-check`,
				{ release }
			);
		},
		rollback(
			orgId: string,
			siteId: string,
			release: string,
			idempotencyKey: string
		): Promise<{ id: string }> {
			return useApi().post<{ id: string }>(
				`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/rollback`,
				{ release },
				{ 'Idempotency-Key': idempotencyKey }
			);
		}
	}
});
