<script setup lang="ts">
import {
	CORPUS_STATUS_LABELS,
	checksSentence,
	coreLabel,
	shapeLabel,
	type CorpusResult,
	type CorpusStatus
} from '~/shared/corpus';

defineProps<{ items: CorpusResult[] }>();
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

const metaOf = (item: CorpusResult) =>
	[coreLabel(item.core), shapeLabel(item.shape)].filter(Boolean).join(', ');
</script>

<template>
	<ul class="divide-y divide-default border-y border-default">
		<li
			v-for="item in items"
			:key="item.id"
			class="grid gap-x-6 gap-y-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
		>
			<div class="flex min-w-0 flex-col gap-1">
				<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
					<h2 class="truncate font-medium text-highlighted">{{ item.title }}</h2>
					<UBadge
						:icon="STATUS_ICONS[item.status]"
						:color="STATUS_COLORS[item.status]"
						variant="subtle"
					>
						{{ CORPUS_STATUS_LABELS[item.status] }}
					</UBadge>
				</div>
				<p
					v-if="item.summary"
					class="truncate text-sm text-default"
				>
					{{ item.summary }}
				</p>
				<p class="line-clamp-2 text-sm text-muted">
					<template v-if="metaOf(item)">{{ metaOf(item) }}. </template
					>{{ checksSentence(item) }}
				</p>
			</div>
			<UButton
				color="neutral"
				variant="outline"
				:aria-label="`Details for ${item.title}`"
				@click="emit('inspect', item)"
				>Details</UButton
			>
		</li>
	</ul>
</template>
