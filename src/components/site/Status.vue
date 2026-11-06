<script setup lang="ts">
import type { SiteState } from '~/stores/sites';

const props = defineProps<{ state: SiteState }>();

const STATUS: Record<SiteState, { label: string; icon: string; tone: string }> = {
	active: {
		label: 'Active',
		icon: 'i-lucide-circle-check',
		tone: 'text-leaf-700 dark:text-leaf-300'
	},
	suspended: {
		label: 'Suspended',
		icon: 'i-lucide-circle-pause',
		tone: 'text-amber-800 dark:text-amber-300'
	},
	tombstoned: { label: 'Removed', icon: 'i-lucide-archive', tone: 'text-muted' },
	'purge-eligible': {
		label: 'Scheduled for Removal',
		icon: 'i-lucide-clock',
		tone: 'text-muted'
	},
	deleted: { label: 'Deleted', icon: 'i-lucide-circle-x', tone: 'text-muted' }
};

const status = computed(() => STATUS[props.state]);
</script>

<template>
	<span
		class="inline-flex items-center gap-1.5 text-sm"
		:class="status.tone"
	>
		<UIcon
			:name="status.icon"
			class="size-4 shrink-0"
			aria-hidden="true"
		/>
		<span>{{ status.label }}</span>
	</span>
</template>
