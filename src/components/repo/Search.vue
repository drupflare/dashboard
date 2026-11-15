<script setup lang="ts">
import { CORPUS_STATUS_LABELS, corpusStatuses, type CorpusStatus } from '~/shared/corpus';

const q = defineModel<string>('q', { required: true });
const status = defineModel<CorpusStatus | 'all'>('status', { required: true });

const statusItems = [
	{ label: 'All Statuses', value: 'all' },
	...corpusStatuses.map((value) => ({ label: CORPUS_STATUS_LABELS[value], value }))
];
</script>

<template>
	<div class="grid gap-4 sm:grid-cols-[1fr_12rem]">
		<UFormField label="Search">
			<UInput
				v-model="q"
				icon="i-lucide-search"
				placeholder="Search by codebase name"
				class="w-full"
			/>
		</UFormField>
		<UFormField label="Status">
			<USelect
				v-model="status"
				:items="statusItems"
				class="w-full"
			/>
		</UFormField>
	</div>
</template>
