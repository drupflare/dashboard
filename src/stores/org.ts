import { defineStore } from 'pinia';
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';

export interface OrgSummary {
	id: string;
	name: string;
	personal: boolean;
	role: string;
}

export interface PlanSummary {
	planId: string;
	features: Record<string, boolean>;
}

interface OrgPage {
	items: OrgSummary[];
	nextCursor: string | null;
}

const COOKIE = 'drupflare_org';

function readCookie(): string | null {
	if (typeof document === 'undefined') return null;
	const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`));
	return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function writeCookie(id: string | null): void {
	if (typeof document === 'undefined') return;
	const value = id
		? `${COOKIE}=${encodeURIComponent(id)}; max-age=31536000`
		: `${COOKIE}=; max-age=0`;
	document.cookie = `${value}; path=/; samesite=lax`;
}

async function fetchAll(): Promise<OrgSummary[]> {
	const items: OrgSummary[] = [];
	let cursor: string | null = null;
	do {
		const page: OrgPage = await useApi().get<OrgPage>(
			'/me/organizations',
			cursor ? { cursor } : undefined
		);
		items.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor);
	return items;
}

export const useOrgStore = defineStore('org', {
	state: () => ({
		// undefined: not loaded; an array (possibly empty): loaded
		items: undefined as OrgSummary[] | undefined,
		currentId: null as string | null,
		// a missing entry is not loaded; a failed read stays missing, and the server still decides
		plans: new Map<string, PlanSummary>(),
		error: null as ApiClientError | null
	}),
	getters: {
		current: (state): OrgSummary | null =>
			state.items?.find((org) => org.id === state.currentId) ?? null,
		currentPlan: (state): PlanSummary | undefined =>
			state.currentId === null ? undefined : state.plans.get(state.currentId)
	},
	actions: {
		async ensure(): Promise<void> {
			if (this.items === undefined) await this.load();
			else this.reconcile();
		},
		async load(): Promise<void> {
			try {
				this.items = await fetchAll();
				this.error = null;
				this.reconcile();
			} catch (error) {
				this.error = toApiClientError(error);
			}
		},
		async loadPlan(orgId: string): Promise<void> {
			if (this.plans.has(orgId)) return;
			try {
				const plan = await useApi().get<PlanSummary>(
					`/orgs/${encodeURIComponent(orgId)}/entitlement`
				);
				this.plans.set(orgId, plan);
			} catch {
				// the create call still checks the plan on the server
			}
		},
		// the stored id is kept only while the list still holds it; otherwise the first organization wins
		reconcile(): void {
			const stored = readCookie();
			const list = this.items ?? [];
			const next = list.some((org) => org.id === stored) ? stored : (list[0]?.id ?? null);
			this.currentId = next;
			if (next !== stored) writeCookie(next);
		},
		select(id: string): void {
			if (!this.items?.some((org) => org.id === id)) return;
			this.currentId = id;
			writeCookie(id);
		},
		reset(): void {
			this.items = undefined;
			this.currentId = null;
			this.plans.clear();
			this.error = null;
		}
	}
});
