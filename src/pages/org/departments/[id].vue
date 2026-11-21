<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { DEPARTMENT_KIND_LABEL, quotaText, type DepartmentView } from '~/shared/departments';
import { useDepartmentsStore } from '~/stores/departments';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth', 'org'] });

const route = useRoute();
const session = useSessionStore();
const org = useOrgStore();
const store = useDepartmentsStore();

const id = computed(() => String(route.params.id ?? ''));
const orgId = computed(() => org.current?.id ?? null);
const list = computed(() => (orgId.value ? store.departments.get(orgId.value) : undefined));
const department = computed<DepartmentView | undefined>(() =>
	list.value?.items.find((d) => d.id === id.value)
);
const members = computed(() =>
	orgId.value ? store.members.get(`${orgId.value}/${id.value}`) : undefined
);
const placements = computed(() => (orgId.value ? store.placements.get(orgId.value) : undefined));

useHead({ title: computed(() => department.value?.name ?? 'Department') });

const crumbs = computed(() => {
	const all = new Map((list.value?.items ?? []).map((d) => [d.id, d]));
	const out: DepartmentView[] = [];
	let at = department.value?.parentId ?? null;
	while (at !== null && all.has(at) && out.length < 8) {
		const parent = all.get(at) as DepartmentView;
		out.unshift(parent);
		at = parent.parentId;
	}
	return out;
});

const view = computed(() => {
	if (session.me === undefined && session.error) return 'session-error';
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (list.value === null) return 'no-org';
	if (!list.value || (list.value.status === 'loading' && list.value.items.length === 0))
		return 'loading';
	if (list.value.status === 'error') return 'error';
	if (!department.value) return 'missing';
	return 'ready';
});

function load(orgIdValue: string) {
	void store.loadDepartments(orgIdValue);
	void store.loadPlacements(orgIdValue);
	void store.loadMembers(orgIdValue, id.value);
}

onMounted(() => {
	if (orgId.value) load(orgId.value);
});

watch([orgId, id], ([next]) => {
	if (next) load(next);
});

function reload() {
	if (orgId.value) void store.fetchDepartments(orgId.value);
}

const deleting = ref(false);
const deleteOpen = ref(false);
const deleteError = ref<string | null>(null);

async function remove(): Promise<void> {
	if (!orgId.value) return;
	deleteError.value = null;
	deleting.value = true;
	try {
		await store.remove(orgId.value, id.value);
		deleteOpen.value = false;
		await navigateTo('/org/departments');
	} catch (cause) {
		deleteError.value = toApiClientError(cause).message;
	} finally {
		deleting.value = false;
	}
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<nav
				aria-label="Breadcrumb"
				class="text-sm text-muted"
			>
				<NuxtLink
					to="/org/departments"
					class="underline-offset-2 hover:underline"
					>Departments</NuxtLink
				>
				<template
					v-for="crumb in crumbs"
					:key="crumb.id"
				>
					<span aria-hidden="true"> / </span>
					<NuxtLink
						:to="`/org/departments/${encodeURIComponent(crumb.id)}`"
						class="underline-offset-2 hover:underline"
						>{{ crumb.name }}</NuxtLink
					>
				</template>
			</nav>

			<UiErrorState
				v-if="view === 'session-error'"
				title="Could Not Load Your Account"
				:text="session.error?.message"
				:request-id="session.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="session.load()"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiErrorState
				v-else-if="view === 'org-error'"
				title="Could Not Load Organizations"
				:text="org.error?.message"
				:request-id="org.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="org.load()"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiEmptyState
				v-else-if="view === 'no-org'"
				icon="i-lucide-building-2"
				title="No Organization Found"
				text="Sign out and sign in again to set up your organization."
			/>

			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading department"
			/>

			<UiErrorState
				v-else-if="view === 'error'"
				title="Could Not Load This Department"
				:text="list?.error?.message"
				:request-id="list?.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="reload"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiEmptyState
				v-else-if="view === 'missing'"
				icon="i-lucide-search-x"
				title="Department Not Found"
				text="It may have been deleted, or it belongs to another organization."
			>
				<UButton
					to="/org/departments"
					color="neutral"
					variant="outline"
					>Back to Departments</UButton
				>
			</UiEmptyState>

			<template v-else-if="department && orgId">
				<UiPageHeader
					:title="department.name"
					:text="`${DEPARTMENT_KIND_LABEL[department.kind]}. ${quotaText(department)}.`"
				/>

				<section
					v-if="department.canManage"
					class="flex flex-col gap-3"
				>
					<h2 class="text-lg font-semibold text-highlighted">Name</h2>
					<TeamDepartmentRename
						:org-id="orgId"
						:department-id="department.id"
						:name="department.name"
					/>
				</section>

				<section
					v-if="list?.central"
					class="flex flex-col gap-3"
				>
					<h2 class="text-lg font-semibold text-highlighted">Site Limit</h2>
					<TeamDepartmentQuota
						:org-id="orgId"
						:department-id="department.id"
						:site-quota="department.siteQuota"
					/>
				</section>

				<section class="flex flex-col gap-3">
					<h2 class="text-lg font-semibold text-highlighted">Members</h2>
					<UiSkeletonTable
						v-if="
							members === undefined ||
							(members?.status === 'loading' && members.items.length === 0)
						"
						label="Loading members"
						:columns="3"
						:rows="2"
					/>
					<UiErrorState
						v-else-if="members === null || members.status === 'error'"
						title="Could Not Load Members"
						:text="members?.error?.message"
						:request-id="members?.error?.requestId"
					>
						<UButton
							color="neutral"
							@click="store.loadMembers(orgId, id)"
							>Try Again</UButton
						>
					</UiErrorState>
					<TeamDepartmentMembers
						v-else
						:org-id="orgId"
						:department-id="department.id"
						:members="members?.items ?? []"
						:can-manage="department.canManage"
					/>
				</section>

				<section class="flex flex-col gap-3">
					<h2 class="text-lg font-semibold text-highlighted">Sites</h2>
					<UiSkeletonTable
						v-if="
							placements === undefined ||
							(placements?.status === 'loading' && placements.items.length === 0)
						"
						label="Loading sites"
						:columns="2"
						:rows="2"
					/>
					<UiErrorState
						v-else-if="placements === null || placements.status === 'error'"
						title="Could Not Load Sites"
						:text="placements?.error?.message"
						:request-id="placements?.error?.requestId"
					>
						<UButton
							color="neutral"
							@click="store.fetchPlacements(orgId)"
							>Try Again</UButton
						>
					</UiErrorState>
					<TeamDepartmentMoveSite
						v-else-if="department.canManage"
						:org-id="orgId"
						:department-id="department.id"
						:sites="placements?.items ?? []"
						:central="list?.central ?? false"
					/>
					<ul
						v-else
						class="divide-y divide-default rounded-lg border border-default px-4"
					>
						<li
							v-for="site in (placements?.items ?? []).filter(
								(s) => s.departmentId === department?.id
							)"
							:key="site.id"
							class="py-2"
						>
							{{ site.name }}
						</li>
					</ul>
				</section>

				<section
					v-if="list?.central"
					class="flex flex-col gap-3"
				>
					<h2 class="text-lg font-semibold text-highlighted">Delete This Department</h2>
					<p class="max-w-prose text-sm text-muted">
						A department with sites or departments inside it cannot be deleted. Move
						them first.
					</p>
					<div>
						<UButton
							color="error"
							variant="outline"
							@click="deleteOpen = true"
							>Delete Department</UButton
						>
					</div>
					<UModal
						v-model:open="deleteOpen"
						title="Delete This Department"
						description="Its member roles go with it. The people stay in the organization."
					>
						<template #body>
							<div class="flex flex-col gap-3">
								<UiConfirmTyped
									:expected="department.name"
									label="Type the department name to confirm"
									action="Delete Department"
									:busy="deleting"
									@confirm="remove"
									@cancel="deleteOpen = false"
								/>
								<p
									v-if="deleteError"
									role="alert"
									class="text-sm text-red-700 dark:text-red-400"
								>
									{{ deleteError }}
								</p>
							</div>
						</template>
					</UModal>
				</section>
			</template>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full" />
		</template>
	</ClientOnly>
</template>
