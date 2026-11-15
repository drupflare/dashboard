<script setup lang="ts">
import type { CorpusResult } from '~/shared/corpus';

const props = defineProps<{ rows: string[]; cells: CorpusResult['cells'] }>();

const LABELS: Record<string, string> = {
	install: 'Install',
	'container build': 'Build Step',
	'anon render': 'Public Pages',
	'auth render': 'Signed-In Pages',
	'entity crud': 'Content Records',
	'form submit': 'Form Submit',
	'file rw': 'File Read and Write',
	'queue cron': 'Queues and Cron',
	'outbound http': 'Outbound Requests',
	update: 'Updates',
	'cache rebuild': 'Cache Rebuild',
	'config import': 'Config Import',
	'module workflow': 'Module Steps'
};

const STATES: Record<string, { label: string; icon: string }> = {
	inline: { label: 'Works', icon: 'i-lucide-circle-check' },
	parked: { label: 'Parked', icon: 'i-lucide-circle-pause' },
	degraded: { label: 'Partly Works', icon: 'i-lucide-circle-alert' },
	unsupported: { label: 'Not Supported', icon: 'i-lucide-circle-x' }
};
const NOT_CHECKED = { label: 'Not Checked', icon: 'i-lucide-circle-help' };

const labelOf = (row: string) => LABELS[row] ?? row;
const stateOf = (row: string) => STATES[props.cells[row]?.state ?? ''] ?? NOT_CHECKED;
</script>

<template>
	<ul class="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
		<li
			v-for="row in rows"
			:key="row"
			class="flex items-center gap-2"
		>
			<UIcon
				:name="stateOf(row).icon"
				class="size-4 shrink-0"
				aria-hidden="true"
			/>
			<span class="text-muted">{{ labelOf(row) }}</span>
			<span class="font-medium text-highlighted">{{ stateOf(row).label }}</span>
		</li>
	</ul>
</template>
