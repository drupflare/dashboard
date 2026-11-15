<script setup lang="ts">
import type { SettingsField } from '~/stores/site-config';

interface Mark {
	value: number;
	label: string;
	note: string;
}

const props = defineProps<{
	value: unknown;
	bounds: SettingsField['bounds'];
	schema: Record<string, unknown>;
}>();

const marks = computed<Mark[]>(() => {
	const raw = props.schema['x-marks'];
	return Array.isArray(raw) ? (raw as Mark[]) : [];
});
const min = computed(() => props.bounds?.min ?? 0);
const max = computed(() => props.bounds?.max ?? min.value + 1);
const unit = computed(() => props.bounds?.unit ?? '');

const current = computed(() => (typeof props.value === 'number' ? props.value : null));
const percent = (v: number) => ((v - min.value) / (max.value - min.value)) * 100;
const currentMark = computed(() => marks.value.find((m) => m.value === current.value) ?? null);
</script>

<template>
	<div class="flex flex-col gap-3">
		<p class="text-sm">
			<span class="font-mono">{{ current ?? 'Not Set' }}</span>
			<span
				v-if="current !== null && unit"
				class="text-muted"
			>
				{{ unit }}
			</span>
			<span
				v-if="currentMark"
				class="ml-2 text-muted"
			>
				{{ currentMark.label }}
			</span>
		</p>
		<div
			class="relative h-6"
			role="img"
			:aria-label="
				current === null
					? 'No position set'
					: `Position ${current}${unit ? ` ${unit}` : ''} of ${min} to ${max}`
			"
		>
			<div class="absolute inset-x-0 top-2.5 h-1 rounded bg-elevated" />
			<div
				v-for="mark in marks"
				:key="mark.value"
				class="absolute top-1.5 size-3 -translate-x-1/2 rounded-full border border-default bg-default"
				:style="{ left: `${percent(mark.value)}%` }"
			/>
			<div
				v-if="current !== null"
				class="absolute top-1 size-4 -translate-x-1/2 rounded-full border-2 border-primary bg-default"
				:style="{ left: `${percent(current)}%` }"
			/>
		</div>
		<ul
			v-if="marks.length"
			class="flex flex-col gap-1 text-xs text-muted"
		>
			<li
				v-for="mark in marks"
				:key="mark.value"
			>
				<span class="font-medium text-default">{{ mark.label }}</span>
				({{ mark.value }}{{ unit ? ` ${unit}` : '' }}): {{ mark.note }}
			</li>
		</ul>
	</div>
</template>
