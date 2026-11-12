<script setup lang="ts">
definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Admin' });

const session = useSessionStore();

const tabs = [
	{ label: 'Overview', icon: 'i-lucide-chart-no-axes-column', value: 'overview' },
	{ label: 'Users', icon: 'i-lucide-users', value: 'users' },
	{ label: 'Organizations', icon: 'i-lucide-building-2', value: 'organizations' },
	{ label: 'Sites', icon: 'i-lucide-globe', value: 'sites' },
	{ label: 'Operations', icon: 'i-lucide-list-checks', value: 'operations' },
	{ label: 'Capacity', icon: 'i-lucide-gauge', value: 'capacity' }
];
const tab = ref('overview');

const lists = {
	users: {
		path: '/admin/users',
		empty: 'No users yet.',
		columns: [
			{ key: 'email', label: 'Email' },
			{ key: 'displayName', label: 'Name' },
			{ key: 'platformRole', label: 'Role' },
			{ key: 'createdAt', label: 'Joined', kind: 'date' as const }
		]
	},
	organizations: {
		path: '/admin/organizations',
		empty: 'No organizations yet.',
		columns: [
			{ key: 'name', label: 'Name' },
			{ key: 'personal', label: 'Personal' },
			{ key: 'id', label: 'ID', kind: 'mono' as const },
			{ key: 'createdAt', label: 'Created', kind: 'date' as const }
		]
	},
	sites: {
		path: '/admin/sites',
		empty: 'No sites yet.',
		columns: [
			{ key: 'name', label: 'Name' },
			{ key: 'kind', label: 'Template' },
			{ key: 'state', label: 'State' },
			{ key: 'primaryHostname', label: 'Hostname' },
			{ key: 'createdAt', label: 'Created', kind: 'date' as const }
		]
	},
	operations: {
		path: '/admin/operations',
		empty: 'No operations yet.',
		columns: [
			{ key: 'type', label: 'Type' },
			{ key: 'status', label: 'Status' },
			{ key: 'verification', label: 'Verification' },
			{ key: 'reason', label: 'Reason' },
			{ key: 'id', label: 'ID', kind: 'mono' as const },
			{ key: 'createdAt', label: 'Created', kind: 'date' as const }
		]
	}
} as const;

type ListTab = keyof typeof lists;
const listFor = computed(() => (tab.value in lists ? lists[tab.value as ListTab] : null));
</script>

<template>
	<ClientOnly>
		<AdminSkeleton v-if="session.me === undefined" />
		<UiEmptyState
			v-else-if="session.me?.platformRole !== 'admin'"
			icon="i-lucide-file-question"
			title="Page Not Found"
			text="There is nothing at this address."
		/>
		<div
			v-else
			class="flex flex-col gap-6"
		>
			<UiPageHeader
				title="Admin"
				text="Read-only platform metadata. Site content is never shown."
			/>
			<UTabs
				v-model="tab"
				:items="tabs"
				:content="false"
				color="neutral"
				variant="link"
			/>
			<AdminOverview v-if="tab === 'overview'" />
			<AdminCapacity v-else-if="tab === 'capacity'" />
			<AdminList
				v-else-if="listFor"
				:key="tab"
				:path="listFor.path"
				:columns="[...listFor.columns]"
				:empty="listFor.empty"
			/>
		</div>
		<template #fallback>
			<AdminSkeleton />
		</template>
	</ClientOnly>
</template>
