<script setup lang="ts">
import { POLICY_COPY, windowSentence, type CutoverPolicyName } from '~/shared/cutover-copy';

defineProps<{ policy: CutoverPolicyName; seconds: number | null }>();
</script>

<template>
	<div class="flex flex-col gap-1 rounded-lg border border-default p-3 text-sm text-default">
		<p class="font-medium text-highlighted">{{ POLICY_COPY[policy].label }}</p>
		<p>{{ POLICY_COPY[policy].consequence }}</p>
		<p data-test="window">{{ windowSentence(policy, seconds) }}</p>
	</div>
</template>
