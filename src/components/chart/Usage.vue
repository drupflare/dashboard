<script setup lang="ts">
import { computed } from 'vue';
import type { Accounting, UsageBar } from '~/shared/usage';

const props = withDefaults(
	defineProps<{ bars: UsageBar[]; ariaLabel: string; showValues?: boolean }>(),
	{ showValues: false }
);

const WIDTH = 600;
const HEIGHT = 200;
const BASE = HEIGHT - 4;
const TOP = 22;

const count = (value: number) => value.toLocaleString('en-US');

const max = computed(() => Math.max(1, ...props.bars.map((bar) => bar.value)));
const slot = computed(() => WIDTH / Math.max(1, props.bars.length));
const barWidth = computed(() => Math.max(2, slot.value * 0.7));

const heightOf = (bar: UsageBar) =>
	bar.state === 'unaccounted' ? BASE - TOP : (bar.value / max.value) * (BASE - TOP);

const xOf = (index: number) => index * slot.value + (slot.value - barWidth.value) / 2;

const fillOf = (state: Accounting) => {
	if (state === 'exact') return 'fill-primary';
	if (state === 'estimated') return 'fill-primary/40 stroke-primary';
	return 'fill-none stroke-muted';
};
</script>

<template>
	<p
		v-if="bars.length === 1"
		class="text-3xl font-semibold tabular-nums text-default"
	>
		{{ count(bars[0]!.value) }}
	</p>
	<svg
		v-else-if="bars.length > 1"
		:viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
		role="img"
		:aria-label="ariaLabel"
		class="h-auto w-full"
	>
		<line
			x1="0"
			:x2="WIDTH"
			:y1="BASE"
			:y2="BASE"
			class="stroke-default"
			stroke-width="1"
		/>
		<g
			v-for="(bar, index) in bars"
			:key="bar.label"
		>
			<rect
				:x="xOf(index)"
				:y="BASE - heightOf(bar)"
				:width="barWidth"
				:height="heightOf(bar)"
				:class="fillOf(bar.state)"
				:stroke-dasharray="bar.state === 'unaccounted' ? '4 3' : undefined"
				stroke-width="1.5"
			/>
			<text
				v-if="showValues"
				:x="xOf(index) + barWidth / 2"
				:y="BASE - heightOf(bar) - 4"
				text-anchor="middle"
				font-size="11"
				class="fill-default tabular-nums"
			>
				{{ count(bar.value) }}
			</text>
		</g>
	</svg>
</template>
