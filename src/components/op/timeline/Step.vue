<script setup lang="ts">
import type { Operation } from '@contracts/operations';

type Step = Operation['steps'][number];

const props = defineProps<{ step: Step }>();

const STATE: Record<Step['state'], { label: string; icon: string; tone: string }> = {
	pending: { label: 'Pending', icon: 'i-lucide-circle-dashed', tone: 'text-muted' },
	running: {
		label: 'Running',
		icon: 'i-lucide-loader-circle',
		tone: 'text-brand-700 dark:text-brand-300'
	},
	succeeded: {
		label: 'Succeeded',
		icon: 'i-lucide-circle-check',
		tone: 'text-leaf-700 dark:text-leaf-300'
	},
	failed: { label: 'Failed', icon: 'i-lucide-circle-x', tone: 'text-red-700 dark:text-red-400' },
	skipped: { label: 'Skipped', icon: 'i-lucide-circle-minus', tone: 'text-muted' }
};

const meta = computed(() => STATE[props.step.state]);
</script>

<template>
	<li class="flex flex-col gap-1 py-3">
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
			<span
				class="inline-flex items-center gap-1.5"
				:class="meta.tone"
			>
				<UIcon
					:name="meta.icon"
					:class="[
						'size-4 shrink-0',
						props.step.state === 'running' ? 'animate-spin' : ''
					]"
					aria-hidden="true"
				/>
				<span>{{ meta.label }}</span>
			</span>
			<span class="font-medium text-highlighted">{{ step.name }}</span>
		</div>
		<p
			v-if="step.error"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ step.error }}
		</p>
	</li>
</template>
