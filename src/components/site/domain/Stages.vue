<script setup lang="ts">
import type { AttachView } from '~/stores/domain';

defineProps<{ view: AttachView }>();

const ICONS = {
	waiting: 'i-lucide-circle',
	pending: 'i-lucide-loader-circle',
	done: 'i-lucide-circle-check',
	failed: 'i-lucide-circle-x'
} as const;

const NAMES = {
	waiting: 'Not started',
	pending: 'In progress',
	done: 'Done',
	failed: 'Stopped'
} as const;
</script>

<template>
	<ol class="flex flex-col gap-3">
		<li
			v-for="stage in view.stages"
			:key="stage.id"
			:data-test="`stage-${stage.id}`"
			:data-state="stage.state"
			class="flex items-start gap-3 rounded-lg border border-default p-3"
		>
			<UIcon
				:name="ICONS[stage.state]"
				class="mt-0.5 size-5 shrink-0"
				:class="{
					'text-green-700 dark:text-green-400': stage.state === 'done',
					'text-red-700 dark:text-red-400': stage.state === 'failed',
					'animate-spin text-primary': stage.state === 'pending',
					'text-muted': stage.state === 'waiting'
				}"
			/>
			<div class="flex flex-col gap-0.5 text-sm">
				<p class="font-medium text-highlighted">
					{{ stage.label }}
					<span class="font-normal text-muted">({{ NAMES[stage.state] }})</span>
				</p>
				<p class="text-default">{{ stage.text }}</p>
			</div>
		</li>
	</ol>
</template>
