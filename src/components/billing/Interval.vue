<script setup lang="ts">
import type { Interval } from '~/shared/plans';

const interval = defineModel<Interval>({ required: true });

const OPTIONS: { value: Interval; label: string }[] = [
	{ value: 'month', label: 'Monthly' },
	{ value: 'year', label: 'Annual' }
];
</script>

<template>
	<div
		role="group"
		aria-label="Billing Period"
		class="inline-flex gap-1 rounded-md border border-default p-1"
	>
		<UButton
			v-for="option in OPTIONS"
			:key="option.value"
			size="sm"
			color="neutral"
			:variant="interval === option.value ? 'solid' : 'ghost'"
			:aria-pressed="interval === option.value"
			@click="interval = option.value"
		>
			{{ option.label }}
		</UButton>
	</div>
</template>
