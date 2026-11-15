<script setup lang="ts">
import type { SettingsField } from '~/stores/site-config';

const props = defineProps<{ value: unknown; bounds: SettingsField['bounds'] }>();

const shown = computed(() => {
	if (typeof props.value === 'number' || typeof props.value === 'string')
		return String(props.value);
	return 'Not Set';
});
const unit = computed(() => props.bounds?.unit ?? '');
const range = computed(() => {
	const { min, max } = props.bounds ?? {};
	if (min === undefined && max === undefined) return null;
	return [min, max]
		.map((n) => (n === undefined ? 'no limit' : `${n}${unit.value ? ` ${unit.value}` : ''}`))
		.join(' to ');
});
</script>

<template>
	<div class="flex flex-col gap-1">
		<p class="text-sm">
			<span class="font-mono">{{ shown }}</span>
			<span
				v-if="unit && shown !== 'Not Set'"
				class="text-muted"
			>
				{{ unit }}
			</span>
		</p>
		<p
			v-if="range"
			class="text-xs text-muted"
		>
			Allowed range: {{ range }}
		</p>
	</div>
</template>
