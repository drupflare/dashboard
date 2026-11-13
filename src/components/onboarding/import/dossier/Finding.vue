<script setup lang="ts">
import type { ImportFinding } from '~/stores/imports';

const props = defineProps<{ finding: ImportFinding }>();

const STATUS: Record<ImportFinding['status'], { label: string; icon: string }> = {
	automatic: { label: 'Carried Over Automatically', icon: 'i-lucide-circle-check' },
	'requires choice': { label: 'Needs Your Choice', icon: 'i-lucide-hand' },
	unsupported: { label: 'Not Supported', icon: 'i-lucide-circle-x' },
	information: { label: 'For Your Information', icon: 'i-lucide-info' }
};

const status = computed(() => STATUS[props.finding.status] ?? STATUS.information);
</script>

<template>
	<li class="flex flex-col gap-1 border-t border-default py-3 first:border-t-0 first:pt-0">
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
			<span class="font-medium text-highlighted">{{ finding.title }}</span>
			<span class="inline-flex items-center gap-1.5 text-sm text-muted">
				<UIcon
					:name="status.icon"
					class="size-4 shrink-0"
					aria-hidden="true"
				/>
				{{ status.label }}
			</span>
		</div>
		<p class="text-sm text-muted">{{ finding.detail }}</p>
	</li>
</template>
