<script setup lang="ts">
import type { RolloutView } from '~/stores/releases';

const props = defineProps<{ rollout: RolloutView }>();

const last = computed(() => props.rollout.rings.findLastIndex((ring) => ring.reached));

type Step = { label: string; icon: string; tone: string };

const WAITING: Step = { label: 'Waiting', icon: 'i-lucide-circle-dashed', tone: 'text-muted' };

function stepOf(index: number): Step {
	if (index > last.value) return WAITING;
	if (index < last.value) {
		return {
			label: 'Done',
			icon: 'i-lucide-circle-check',
			tone: 'text-leaf-700 dark:text-leaf-300'
		};
	}
	switch (props.rollout.status) {
		case 'rolling':
			return {
				label: 'Updating',
				icon: 'i-lucide-loader-circle',
				tone: 'text-amber-800 dark:text-amber-300'
			};
		case 'complete':
			return {
				label: 'Done',
				icon: 'i-lucide-circle-check',
				tone: 'text-leaf-700 dark:text-leaf-300'
			};
		case 'halted':
			return {
				label: 'Stopped here',
				icon: 'i-lucide-octagon-x',
				tone: 'text-red-700 dark:text-red-400'
			};
		default:
			return {
				label: 'Put back',
				icon: 'i-lucide-undo-2',
				tone: 'text-red-700 dark:text-red-400'
			};
	}
}

const number = (ring: string) => ring.replace('R', '');
</script>

<template>
	<ol
		class="flex flex-col gap-2"
		aria-label="Rollout progress by ring"
	>
		<li
			v-for="(ring, index) in rollout.rings"
			:key="ring.ring"
			class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
		>
			<span class="w-14 font-medium text-highlighted">Ring {{ number(ring.ring) }}</span>
			<span
				class="inline-flex items-center gap-1.5"
				:class="stepOf(index).tone"
			>
				<UIcon
					:name="stepOf(index).icon"
					class="size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>{{ stepOf(index).label }}</span>
			</span>
			<span
				v-if="ring.reached"
				class="text-muted"
			>
				{{ ring.upgraded }} updated<template v-if="ring.failed > 0"
					>, {{ ring.failed }} did not take it</template
				><template v-if="ring.reverted > 0">, {{ ring.reverted }} put back</template
				><template v-if="ring.stuck > 0">, {{ ring.stuck }} could not be put back</template>
			</span>
		</li>
	</ol>
</template>
