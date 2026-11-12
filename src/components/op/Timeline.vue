<script setup lang="ts">
import type { Operation } from '@contracts/operations';

defineProps<{ steps: Operation['steps']; type: string }>();
</script>

<template>
	<ol class="flex flex-col divide-y divide-default rounded-lg border border-default px-4">
		<OpTimelineStep
			v-for="step in steps"
			:key="step.id"
			:step="step"
			:type="type"
		/>
	</ol>
</template>
