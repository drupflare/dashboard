<script setup lang="ts">
import { useDepartmentsStore } from '~/stores/departments';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Departments' });

const session = useSessionStore();
const org = useOrgStore();
const store = useDepartmentsStore();

const orgId = computed(() => org.current?.id ?? null);
const list = computed(() => (orgId.value ? store.departments.get(orgId.value) : undefined));
const rows = computed(() => list.value?.items ?? []);

const view = computed(() => {
	if (session.me === undefined && session.error) return 'session-error';
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (list.value === null) return 'no-org';
	if (!list.value || (list.value.status === 'loading' && rows.value.length === 0))
		return 'loading';
	if (list.value.status === 'error') return 'error';
	if (rows.value.length === 0) return 'empty';
	return 'list';
});

onMounted(() => {
	if (orgId.value) void store.loadDepartments(orgId.value);
});

watch(orgId, (id) => {
	if (id) void store.loadDepartments(id);
});

function reload() {
	if (orgId.value) void store.fetchDepartments(orgId.value);
}

async function created(department: { id: string }) {
	await navigateTo(`/org/departments/${encodeURIComponent(department.id)}`);
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Departments"
				text="Divisions and departments, with the sites and people in each."
			>
				<TeamDepartmentCreateDialog
					v-if="orgId && list?.central"
					:org-id="orgId"
					:departments="rows"
					@created="created"
				/>
			</UiPageHeader>

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
				label="Loading departments"
			/>

			<UiErrorState
				v-else-if="view === 'error'"
				title="Could Not Load Departments"
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
				v-else-if="view === 'empty'"
				icon="i-lucide-network"
				title="No Departments Yet"
				:text="
					list?.central
						? 'Create a department to give a team its own people and a Site Limit.'
						: 'An organization owner or admin can create departments.'
				"
			/>

			<TeamDepartmentTree
				v-else
				:departments="rows"
			/>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full" />
		</template>
	</ClientOnly>
</template>
