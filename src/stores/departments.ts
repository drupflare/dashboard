import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type {
	DepartmentCreateBody,
	DepartmentList,
	DepartmentMemberBody,
	DepartmentMemberList,
	DepartmentMemberView,
	DepartmentRole,
	DepartmentUpdateBody,
	DepartmentView,
	PlacementList,
	PlacementSite,
	SiteDepartmentView
} from '~/shared/departments';

export interface DepartmentLoad<T> {
	items: T[];
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

export interface DepartmentsEntry extends DepartmentLoad<DepartmentView> {
	// an organization owner or admin: the only people who set limits and shape the tree
	central: boolean;
}

const orgPath = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}`;
const deptPath = (orgId: string, id: string) =>
	`${orgPath(orgId)}/departments/${encodeURIComponent(id)}`;

// every map is keyed by organization id (members by organization and department); undefined: not
// loaded; null: no such organization or department; an object: loaded
export const useDepartmentsStore = defineStore('departments', {
	state: () => ({
		departments: new Map<string, DepartmentsEntry | null>(),
		placements: new Map<string, DepartmentLoad<PlacementSite> | null>(),
		members: new Map<string, DepartmentLoad<DepartmentMemberView> | null>()
	}),
	actions: {
		async loadDepartments(orgId: string): Promise<void> {
			const existing = this.departments.get(orgId);
			if (
				existing === null ||
				existing?.status === 'ready' ||
				existing?.status === 'loading'
			) {
				return;
			}
			await this.fetchDepartments(orgId);
		},
		async fetchDepartments(orgId: string): Promise<void> {
			this.departments.set(orgId, {
				items: [],
				central: false,
				status: 'loading',
				error: null
			});
			try {
				const list = await useApi().get<DepartmentList>(`${orgPath(orgId)}/departments`);
				this.departments.set(orgId, {
					items: list.items,
					central: list.central,
					status: 'ready',
					error: null
				});
			} catch (cause) {
				const failure = toApiClientError(cause);
				this.departments.set(
					orgId,
					failure.status === 404
						? null
						: { items: [], central: false, status: 'error', error: failure }
				);
			}
		},
		// counts change whenever a department or a site moves, so a change refreshes both lists
		async refresh(orgId: string): Promise<void> {
			await Promise.all([this.fetchDepartments(orgId), this.fetchPlacements(orgId)]);
		},
		async loadPlacements(orgId: string): Promise<void> {
			const existing = this.placements.get(orgId);
			if (
				existing === null ||
				existing?.status === 'ready' ||
				existing?.status === 'loading'
			) {
				return;
			}
			await this.fetchPlacements(orgId);
		},
		async fetchPlacements(orgId: string): Promise<void> {
			this.placements.set(orgId, { items: [], status: 'loading', error: null });
			try {
				const list = await useApi().get<PlacementList>(
					`${orgPath(orgId)}/departments/sites`
				);
				this.placements.set(orgId, { items: list.items, status: 'ready', error: null });
			} catch (cause) {
				const failure = toApiClientError(cause);
				this.placements.set(
					orgId,
					failure.status === 404 ? null : { items: [], status: 'error', error: failure }
				);
			}
		},
		async create(orgId: string, body: DepartmentCreateBody): Promise<DepartmentView> {
			const created = await useApi().post<DepartmentView>(
				`${orgPath(orgId)}/departments`,
				body
			);
			await this.fetchDepartments(orgId);
			return created;
		},
		async edit(orgId: string, id: string, body: DepartmentUpdateBody): Promise<DepartmentView> {
			const updated = await useApi().put<DepartmentView>(deptPath(orgId, id), body);
			await this.fetchDepartments(orgId);
			return updated;
		},
		async setQuota(
			orgId: string,
			id: string,
			siteQuota: number | null
		): Promise<DepartmentView> {
			const updated = await useApi().put<DepartmentView>(`${deptPath(orgId, id)}/quota`, {
				siteQuota
			});
			await this.fetchDepartments(orgId);
			return updated;
		},
		async remove(orgId: string, id: string): Promise<void> {
			await useApi().delete(deptPath(orgId, id));
			this.members.delete(`${orgId}/${id}`);
			await this.fetchDepartments(orgId);
		},
		async loadMembers(orgId: string, id: string): Promise<void> {
			const key = `${orgId}/${id}`;
			this.members.set(key, { items: [], status: 'loading', error: null });
			try {
				const list = await useApi().get<DepartmentMemberList>(
					`${deptPath(orgId, id)}/members`
				);
				this.members.set(key, { items: list.items, status: 'ready', error: null });
			} catch (cause) {
				const failure = toApiClientError(cause);
				this.members.set(
					key,
					failure.status === 404 ? null : { items: [], status: 'error', error: failure }
				);
			}
		},
		async addMember(
			orgId: string,
			id: string,
			body: DepartmentMemberBody
		): Promise<DepartmentMemberView> {
			const added = await useApi().post<DepartmentMemberView>(
				`${deptPath(orgId, id)}/members`,
				body
			);
			await Promise.all([this.loadMembers(orgId, id), this.fetchDepartments(orgId)]);
			return added;
		},
		async changeRole(
			orgId: string,
			id: string,
			userId: string,
			role: DepartmentRole
		): Promise<void> {
			const updated = await useApi().put<DepartmentMemberView>(
				`${deptPath(orgId, id)}/members/${encodeURIComponent(userId)}/role`,
				{ role }
			);
			const list = this.members.get(`${orgId}/${id}`);
			const at = list?.items.findIndex((item) => item.userId === userId) ?? -1;
			if (list && at >= 0) list.items[at] = updated;
		},
		async removeMember(orgId: string, id: string, userId: string): Promise<void> {
			await useApi().delete(`${deptPath(orgId, id)}/members/${encodeURIComponent(userId)}`);
			const list = this.members.get(`${orgId}/${id}`);
			if (list) list.items = list.items.filter((item) => item.userId !== userId);
			await this.fetchDepartments(orgId);
		},
		async moveSite(
			orgId: string,
			siteId: string,
			departmentId: string | null
		): Promise<SiteDepartmentView> {
			const moved = await useApi().put<SiteDepartmentView>(
				`${orgPath(orgId)}/sites/${encodeURIComponent(siteId)}/department`,
				{ departmentId }
			);
			await this.refresh(orgId);
			return moved;
		},
		reset(): void {
			this.departments.clear();
			this.placements.clear();
			this.members.clear();
		}
	}
});
