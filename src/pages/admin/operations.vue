<script setup lang="ts">
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Operations' });

const session = useSessionStore();

const filters = [
	{ label: 'All', value: 'all' },
	{ label: 'In Flight', value: 'in-flight' },
	{ label: 'Failed', value: 'failed' }
];
const filter = ref('all');

const columns = [
	{ key: 'type', label: 'Type' },
	{ key: 'status', label: 'Status' },
	{ key: 'verification', label: 'Verification' },
	{ key: 'reason', label: 'Reason' },
	{ key: 'id', label: 'ID', kind: 'mono' as const },
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
			title="Operations"
			text="Work in flight and work that failed, with the plain reason it stopped."
		/>
		<UTabs
			v-model="filter"
			:items="filters"
			:content="false"
			color="neutral"
			variant="link"
		/>
		<AdminList
			:key="filter"
			path="/admin/operations"
			:query="{ filter }"
			:columns="columns"
			empty="No operations match this view."
		/>
	</div>
</template>
