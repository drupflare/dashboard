<script setup lang="ts">
import { policyBlockText, type PolicyBlockDetail } from '~/shared/policies';

defineProps<{ detail: PolicyBlockDetail }>();
</script>

<template>
	<div
		role="note"
		class="flex flex-col gap-1 rounded-md border border-default p-3 text-sm"
	>
		<p class="font-medium text-highlighted">Why Was This Blocked</p>
		<p class="text-default">{{ policyBlockText(detail) }}</p>
	</div>
</template>
