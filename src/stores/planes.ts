import type { Operation } from '@contracts/operations';
import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { ProbeReport } from '~/shared/cloudflare-probe';
import type { ConnectResult, PlaneConnectionView, RevokeResult } from '~/shared/plane-connections';

const planePath = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/planes/cloudflare`;

export interface SelfManagedSiteBody {
	kind: 'drupal' | 'nuxtpress' | 'mylora';
	name: string;
	connectionId: string;
	customHost?: { hostname: string; zoneId: string };
}

// no token is kept here; the probe report and the connection list are held in memory only
export const usePlanesStore = defineStore('planes', {
	state: () => ({
		// undefined: no check has run; a report: the last check's answer
		report: undefined as ProbeReport | undefined,
		probing: false,
		error: null as ApiClientError | null,
		// keyed by org id; a missing key is not loaded
		connections: new Map<string, PlaneConnectionView[]>(),
		listing: false,
		listError: null as ApiClientError | null,
		connecting: false,
		connectError: null as ApiClientError | null
	}),
	getters: {
		activeFor:
			(state) =>
			(orgId: string): PlaneConnectionView[] =>
				(state.connections.get(orgId) ?? []).filter((item) => item.state === 'active')
	},
	actions: {
		async probe(orgId: string, token: string, accountId?: string): Promise<void> {
			this.probing = true;
			this.error = null;
			try {
				this.report = await useApi().post<ProbeReport>(
					`${planePath(orgId)}/probe`,
					accountId === undefined ? { token } : { token, accountId }
				);
			} catch (cause) {
				this.report = undefined;
				this.error = toApiClientError(cause);
			} finally {
				this.probing = false;
			}
		},
		clear(): void {
			this.report = undefined;
			this.error = null;
			this.probing = false;
			this.connectError = null;
		},
		async loadConnections(orgId: string, force = false): Promise<void> {
			if (this.listing || (!force && this.connections.has(orgId))) return;
			this.listing = true;
			this.listError = null;
			try {
				const page = await useApi().get<{ items: PlaneConnectionView[] }>(planePath(orgId));
				this.connections.set(orgId, page.items);
			} catch (cause) {
				this.listError = toApiClientError(cause);
			} finally {
				this.listing = false;
			}
		},
		// the stored token is sealed on the server; the answer never carries it
		async connect(orgId: string, token: string, accountId?: string): Promise<ConnectResult> {
			this.connecting = true;
			this.connectError = null;
			try {
				const result = await useApi().post<ConnectResult>(
					planePath(orgId),
					accountId === undefined ? { token } : { token, accountId }
				);
				this.replace(orgId, result.connection);
				return result;
			} catch (cause) {
				this.connectError = toApiClientError(cause);
				throw this.connectError;
			} finally {
				this.connecting = false;
			}
		},
		async validate(orgId: string, id: string): Promise<PlaneConnectionView> {
			const view = await useApi().post<PlaneConnectionView>(
				`${planePath(orgId)}/${encodeURIComponent(id)}/validate`,
				{}
			);
			this.replace(orgId, view);
			return view;
		},
		async revoke(orgId: string, id: string, force: string[] = []): Promise<RevokeResult> {
			const query = force.length === 0 ? '' : `?force=${encodeURIComponent(force.join(','))}`;
			const result = await useApi().delete<RevokeResult>(
				`${planePath(orgId)}/${encodeURIComponent(id)}${query}`
			);
			this.replace(orgId, result.connection);
			return result;
		},
		createSite(
			orgId: string,
			body: SelfManagedSiteBody,
			idempotencyKey: string
		): Promise<Operation> {
			return useApi().post<Operation>(
				`/orgs/${encodeURIComponent(orgId)}/sites`,
				{ ...body, plane: 'self-managed' },
				{ 'Idempotency-Key': idempotencyKey }
			);
		},
		replace(orgId: string, view: PlaneConnectionView): void {
			const list = this.connections.get(orgId) ?? [];
			const at = list.findIndex((item) => item.id === view.id);
			if (at < 0) this.connections.set(orgId, [...list, view]);
			else
				this.connections.set(
					orgId,
					list.map((item) => (item.id === view.id ? view : item))
				);
		}
	}
});
