<script setup lang="ts">
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Sites' });

const session = useSessionStore();

const columns = [
	{ key: 'name', label: 'Name' },
	{ key: 'kind', label: 'Template' },
	{ key: 'plane', label: 'Plane' },
	{ key: 'state', label: 'State' },
	{ key: 'primaryHostname', label: 'Hostname' },
	{ key: 'organizationId', label: 'Organization', kind: 'mono' as const },
	{ key: 'createdAt', label: 'Created', kind: 'date' as const }
];
</script>

<template>
	<UiEmptyState
		v-if="session.me !== undefined && session.me?.platformRole !== 'admin'"
		icon="i-lucide-file-question"
		title="Page Not Found"
		text="There is nothing at this address."
	/>
	<div
		v-else
		class="flex flex-col gap-6"
	>
		<UiPageHeader
			title="Sites"
			text="Read-only site metadata across every shard. Site content is never shown."
		/>
		<AdminList
			path="/admin/sites"
			:columns="columns"
			empty="No sites yet."
		/>
	</div>
</template>
