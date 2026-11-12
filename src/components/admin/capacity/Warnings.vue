<script setup lang="ts">
import type { CapacityWarning } from '~/shared/capacity';

defineProps<{ warnings: CapacityWarning[] }>();
</script>

<template>
	<div
		v-if="warnings.length > 0"
		class="flex max-w-xl flex-col gap-3"
		role="alert"
	>
		<UAlert
			v-for="warning in warnings"
			:key="warning.id"
			color="warning"
			variant="subtle"
			icon="i-lucide-triangle-alert"
			:title="warning.title"
			:description="warning.text"
		/>
	</div>
</template>
