<script setup lang="ts">
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Organizations' });

const session = useSessionStore();

const draft = ref('');
const applied = ref('');

function search(): void {
	applied.value = draft.value.trim();
}

const columns = [
	{ key: 'name', label: 'Name' },
	{ key: 'personal', label: 'Personal' },
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
			title="Organizations"
			text="Read-only organization metadata. Open one to see its counts and plan."
		/>
		<form
			class="flex max-w-md gap-2"
			role="search"
			@submit.prevent="search"
		>
			<UInput
				v-model="draft"
				placeholder="Search by name"
				aria-label="Search organizations by name"
				class="flex-1"
			/>
			<UButton
				type="submit"
				color="neutral"
				variant="outline"
				>Search</UButton
			>
		</form>
		<AdminList
			:key="applied"
			path="/admin/organizations"
			:query="applied === '' ? {} : { q: applied }"
			:columns="columns"
			empty="No organizations match this search."
			row-to="/admin/orgs/"
		/>
	</div>
</template>
