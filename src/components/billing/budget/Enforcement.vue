<script setup lang="ts">
import type { Enforcement } from '~/shared/budget-rules';

defineProps<{
	modelValue: Enforcement;
	// the server's bound on how soon a stop takes effect
	appliesWithin: string;
	disabled: boolean;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: Enforcement];
	change: [value: Enforcement];
}>();

const options: { value: Enforcement; label: string; text: string }[] = [
	{
		value: 'block',
		label: 'Stop the Site at the Limit',
		text: 'Visitors see an unavailable page once the budget is used up. Owner tools keep working.'
	},
	{
		value: 'alert',
		label: 'Send Alerts Only',
		text: 'Nothing is blocked. You get an email at each alert threshold.'
	}
];

function pick(value: Enforcement): void {
	emit('update:modelValue', value);
	emit('change', value);
}
</script>

<template>
	<fieldset class="flex flex-col gap-3">
		<legend class="text-sm font-medium text-default">When the Budget Is Reached</legend>
		<label
			v-for="option in options"
			:key="option.value"
			class="flex cursor-pointer items-start gap-3 rounded-lg border border-default p-4"
			:class="{ 'opacity-60': disabled }"
		>
			<input
				type="radio"
				name="budget-enforcement"
				class="mt-1"
				:value="option.value"
				:checked="modelValue === option.value"
				:disabled="disabled"
				@change="pick(option.value)"
			/>
			<span class="flex flex-col gap-1">
				<span class="font-medium text-default">{{ option.label }}</span>
				<span class="text-sm text-muted">{{ option.text }}</span>
			</span>
		</label>
		<p class="text-sm text-muted">{{ appliesWithin }}</p>
	</fieldset>
</template>
