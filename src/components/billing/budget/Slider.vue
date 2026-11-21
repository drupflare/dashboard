<script setup lang="ts">
import { percentToPosition, positionToPercent, snapPercent } from '~/shared/budget-rules';

const props = defineProps<{
	label: string;
	percent: number;
	// the most the slider reaches, from the organization budget; null is no ceiling
	ceiling: number | null;
	disabled: boolean;
}>();

const emit = defineEmits<{
	'update:percent': [percent: number];
	commit: [];
}>();

const max = computed(() => (props.ceiling === null ? 1 : percentToPosition(props.ceiling)));
const position = computed(() => percentToPosition(props.percent));

function onInput(event: Event): void {
	const raw = positionToPercent(Number((event.target as HTMLInputElement).value));
	const snapped = snapPercent(raw);
	emit('update:percent', props.ceiling === null ? snapped : Math.min(snapped, props.ceiling));
}
</script>

<template>
	<input
		type="range"
		class="w-full"
		min="0"
		:max="max"
		step="any"
		:value="position"
		:disabled="disabled"
		:aria-label="label"
		:aria-valuetext="`${percent} percent of your included views`"
		@input="onInput"
		@change="emit('commit')"
	/>
</template>
