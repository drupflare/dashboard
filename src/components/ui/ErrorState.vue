<script setup lang="ts">
import type { PolicyBlockDetail } from '~/shared/policies';

const props = withDefaults(
	defineProps<{
		title: string;
		text?: string;
		requestId?: string | null;
		// the error details; a policy refusal names its group and rule
		detail?: unknown;
	}>(),
	{ text: 'The request failed. Try again.' }
);

const policy = computed<PolicyBlockDetail | null>(() => {
	const value = props.detail;
	if (typeof value !== 'object' || value === null) return null;
	const block = value as PolicyBlockDetail;
	return block.requires === 'policy' ? block : null;
});
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
		<TeamPolicyWhy
			v-if="policy"
			:detail="policy"
		/>
		<slot />
	</div>
</template>
