<script setup lang="ts">
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Capacity' });

const session = useSessionStore();
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
			title="Capacity"
			text="Credits, Cloudflare usage and account headroom, with the numbers as they were read."
		/>
		<AdminCapacity />
	</div>
</template>
