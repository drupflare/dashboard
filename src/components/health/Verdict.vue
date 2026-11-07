<script setup lang="ts">
import type { HealthStatus } from '~/shared/health/view';

const props = defineProps<{ status: HealthStatus; level: string }>();

const VERDICT: Record<HealthStatus, { label: string; icon: string; tone: string }> = {
	healthy: {
		label: 'Healthy',
		icon: 'i-lucide-circle-check',
		tone: 'text-leaf-700 dark:text-leaf-300'
	},
	attention: {
		label: 'Needs Attention',
		icon: 'i-lucide-triangle-alert',
		tone: 'text-amber-800 dark:text-amber-300'
	},
	starting: {
		label: 'Starting',
		icon: 'i-lucide-loader-circle',
		tone: 'text-brand-700 dark:text-brand-300'
	},
	unreachable: {
		label: 'Not Responding',
		icon: 'i-lucide-circle-x',
		tone: 'text-red-700 dark:text-red-400'
	},
	unreadable: {
		label: 'Health Unavailable',
		icon: 'i-lucide-circle-help',
		tone: 'text-amber-800 dark:text-amber-300'
	}
};

const verdict = computed(() => VERDICT[props.status]);
const severe = computed(
	() => props.status === 'attention' && (props.level === 'error' || props.level === 'critical')
);

const announcement = ref('');
watch(
	() => verdict.value.label,
	(label) => {
		announcement.value = `Site health changed to ${label}.`;
	}
);
</script>

<template>
	<div class="flex items-center gap-2">
		<span
			class="inline-flex items-center gap-2 text-lg font-semibold"
			:class="severe ? 'text-red-700 dark:text-red-400' : verdict.tone"
		>
			<UIcon
				:name="verdict.icon"
				:class="['size-6 shrink-0', status === 'starting' ? 'animate-spin' : '']"
				aria-hidden="true"
			/>
			<span data-test="verdict-label">{{ verdict.label }}</span>
		</span>
		<p
			role="status"
			aria-live="polite"
			class="sr-only"
			data-test="verdict-announcement"
		>
			{{ announcement }}
		</p>
	</div>
</template>
