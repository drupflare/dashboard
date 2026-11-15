<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import { CORPUS_STATUS_LABELS, type CorpusResult, type CorpusStatus } from '~/shared/corpus';

defineProps<{ items: CorpusResult[]; rows: string[] }>();
const emit = defineEmits<{ inspect: [item: CorpusResult] }>();

const STATUS_ICONS: Record<CorpusStatus, string> = {
	deployed: 'i-lucide-rocket',
	verified: 'i-lucide-circle-check',
	partial: 'i-lucide-circle-alert',
	'needs upgrade': 'i-lucide-arrow-up-circle',
	unsupported: 'i-lucide-circle-x'
};

const STATUS_COLORS: Record<CorpusStatus, 'success' | 'warning' | 'error' | 'neutral'> = {
	deployed: 'success',
	verified: 'success',
	partial: 'warning',
	'needs upgrade': 'warning',
	unsupported: 'error'
};

const columns: TableColumn<CorpusResult>[] = [
	{ accessorKey: 'name', header: 'Codebase' },
	{ accessorKey: 'status', header: 'Status' },
	{ accessorKey: 'install', header: 'Install' },
	{ id: 'capabilities', header: 'Capabilities' },
	{ id: 'actions', header: '' }
];
</script>

<template>
	<UTable
		:data="items"
		:columns="columns"
		class="w-full"
	>
		<template #name-cell="{ row }">
			<span class="font-medium text-highlighted">{{ row.original.name }}</span>
		</template>
		<template #status-cell="{ row }">
			<UBadge
				:icon="STATUS_ICONS[row.original.status]"
				:color="STATUS_COLORS[row.original.status]"
				variant="subtle"
			>
				{{ CORPUS_STATUS_LABELS[row.original.status] }}
			</UBadge>
		</template>
		<template #install-cell="{ row }">
			<div class="flex flex-col gap-1">
				<UBadge
					v-if="row.original.install.allowed"
					icon="i-lucide-check"
					color="success"
					variant="subtle"
				>
					Allowed
				</UBadge>
				<UBadge
					v-else
					icon="i-lucide-ban"
					color="error"
					variant="subtle"
				>
					Refused
				</UBadge>
				<p
					v-if="!row.original.install.allowed"
					class="text-sm text-muted"
				>
					{{ row.original.install.reason }}
				</p>
			</div>
		</template>
		<template #capabilities-cell="{ row }">
			<RepoCorpusCells
				:rows="rows"
				:cells="row.original.cells"
			/>
		</template>
		<template #actions-cell="{ row }">
			<UButton
				color="neutral"
				variant="outline"
				@click="emit('inspect', row.original)"
				>Install Options</UButton
			>
		</template>
	</UTable>
</template>
