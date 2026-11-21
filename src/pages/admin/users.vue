<script setup lang="ts">
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Users' });

const session = useSessionStore();

const columns = [
	{ key: 'email', label: 'Email' },
	{ key: 'displayName', label: 'Name' },
	{ key: 'platformRole', label: 'Role' },
	{ key: 'createdAt', label: 'Joined', kind: 'date' as const }
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
			title="Users"
			text="Read-only account metadata. Site content is never shown."
		/>
		<AdminList
			path="/admin/users"
			:columns="columns"
			empty="No users yet."
		/>
	</div>
</template>
