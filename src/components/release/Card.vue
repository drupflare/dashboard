<script setup lang="ts">
import { plainDuration, plainReason } from '~/shared/rollout-copy';
import type { ReleaseView } from '~/stores/releases';

const props = defineProps<{ release: ReleaseView; busy?: boolean }>();
const emit = defineEmits<{ rollOut: [release: ReleaseView]; stop: [release: ReleaseView] }>();

const rollout = computed(() => props.release.rollout);
const running = computed(() => rollout.value?.status === 'rolling');
const stopped = computed(
	() => rollout.value?.status === 'halted' || rollout.value?.status === 'reverted'
);

const published = computed(() => new Date(props.release.publishedAt).toISOString().slice(0, 10));

const SUMMARY = {
	rolling: {
		label: 'Rolling Out',
		icon: 'i-lucide-loader-circle',
		tone: 'text-amber-800 dark:text-amber-300'
	},
	complete: {
		label: 'Fully Rolled Out',
		icon: 'i-lucide-circle-check',
		tone: 'text-leaf-700 dark:text-leaf-300'
	},
	halted: {
		label: 'Stopped',
		icon: 'i-lucide-octagon-x',
		tone: 'text-red-700 dark:text-red-400'
	},
	reverted: { label: 'Put Back', icon: 'i-lucide-undo-2', tone: 'text-red-700 dark:text-red-400' }
} as const;
</script>

<template>
	<article
		class="flex flex-col gap-4 rounded-lg border border-default p-4"
		:aria-label="`Release ${release.version}`"
	>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex flex-col">
				<h2 class="text-lg font-semibold text-highlighted">
					Release {{ release.version }}
				</h2>
				<p class="text-sm text-muted">
					Published {{ published
					}}<template v-if="release.advisoryAt !== null">
						after a security advisory</template
					>
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-3">
				<p
					v-if="rollout"
					class="inline-flex items-center gap-1.5 text-sm"
					:class="SUMMARY[rollout.status].tone"
				>
					<UIcon
						:name="SUMMARY[rollout.status].icon"
						class="size-4 shrink-0"
						aria-hidden="true"
					/>
					<span>{{ SUMMARY[rollout.status].label }}</span>
				</p>
				<UButton
					v-if="running"
					color="neutral"
					variant="outline"
					icon="i-lucide-hand"
					:disabled="busy || rollout?.stopRequested"
					@click="emit('stop', release)"
					>{{ rollout?.stopRequested ? 'Stopping' : 'Stop Rollout' }}</UButton
				>
				<UButton
					v-else
					icon="i-lucide-rocket"
					:disabled="busy"
					@click="emit('rollOut', release)"
					>Roll Out</UButton
				>
			</div>
		</div>

		<ReleaseRings
			v-if="rollout"
			:rollout="rollout"
		/>
		<p
			v-else
			class="text-sm text-muted"
		>
			This release has not been rolled out.
		</p>

		<ul
			v-if="stopped && rollout"
			class="flex flex-col gap-1 text-sm text-red-700 dark:text-red-400"
			aria-label="Why the rollout stopped"
		>
			<li
				v-for="reason in rollout.reasons"
				:key="reason"
			>
				{{ plainReason(reason) }}
			</li>
		</ul>

		<p
			v-if="rollout && rollout.advisoryIntervalMs !== null"
			class="text-sm text-muted"
		>
			Time from the advisory to the last ring:
			{{ plainDuration(rollout.advisoryIntervalMs) }}.
		</p>
		<p
			v-else-if="rollout && release.advisoryAt !== null"
			class="text-sm text-muted"
		>
			Time from the advisory to the last ring is not known yet.
		</p>
	</article>
</template>
