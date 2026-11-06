<script setup lang="ts">
import type { Operation } from '@contracts/operations';

const props = defineProps<{ status: Operation['status'] }>();

const STATUS: Record<Operation['status'], { label: string; icon: string; tone: string }> = {
	planned: { label: 'Planned', icon: 'i-lucide-circle-dashed', tone: 'text-muted' },
	'awaiting-approval': {
		label: 'Awaiting Approval',
		icon: 'i-lucide-hand',
		tone: 'text-amber-800 dark:text-amber-300'
	},
	running: {
		label: 'Running',
		icon: 'i-lucide-loader-circle',
		tone: 'text-brand-700 dark:text-brand-300'
	},
	verifying: {
		label: 'Verifying',
		icon: 'i-lucide-search-check',
		tone: 'text-brand-700 dark:text-brand-300'
	},
	succeeded: {
		label: 'Succeeded',
		icon: 'i-lucide-circle-check',
		tone: 'text-leaf-700 dark:text-leaf-300'
	},
	failed: { label: 'Failed', icon: 'i-lucide-circle-x', tone: 'text-red-700 dark:text-red-400' },
	cancelled: { label: 'Cancelled', icon: 'i-lucide-circle-slash', tone: 'text-muted' },
	'rolled-back': {
		label: 'Rolled Back',
		icon: 'i-lucide-undo-2',
		tone: 'text-amber-800 dark:text-amber-300'
	}
};

const status = computed(() => STATUS[props.status]);
</script>

<template>
	<span
		class="inline-flex items-center gap-1.5 text-sm"
		:class="status.tone"
	>
		<UIcon
			:name="status.icon"
			:class="['size-4 shrink-0', props.status === 'running' ? 'animate-spin' : '']"
			aria-hidden="true"
		/>
		<span>{{ status.label }}</span>
	</span>
</template>
