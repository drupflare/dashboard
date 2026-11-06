<script setup lang="ts">
defineProps<{
	title: string;
	text: string;
	requestId?: string | null;
}>();
</script>

<template>
	<div
		role="alert"
		class="flex flex-col items-center gap-3 rounded-lg border border-red-700/40 px-6 py-10 text-center dark:border-red-400/40"
	>
		<UIcon
			name="i-lucide-triangle-alert"
			class="size-8 text-red-700 dark:text-red-400"
			aria-hidden="true"
		/>
		<h2 class="text-lg font-semibold text-highlighted">{{ title }}</h2>
		<p class="max-w-prose text-sm text-muted">{{ text }}</p>
		<p
			v-if="requestId"
			class="text-xs text-muted"
		>
			Request ID: <code class="break-all">{{ requestId }}</code>
		</p>
		<slot />
	</div>
</template>
