<script setup lang="ts">
import type { RepairList, RepairView } from '~/stores/repairs';
import Row from './Row.vue';

defineProps<{
	list: RepairList | undefined;
	undoing: string | null;
	undoError: string | null;
}>();
const emit = defineEmits<{ loadMore: []; undo: [repair: RepairView] }>();
</script>

<template>
	<section
		aria-labelledby="repair-log-title"
		class="rounded-lg border border-default"
	>
		<h2
			id="repair-log-title"
			class="px-4 py-3 text-lg font-semibold"
		>
			Automatic Repairs
		</h2>
		<p
			v-if="list?.status === 'loading' && list.items.length === 0"
			class="px-4 pb-4 text-sm text-muted"
			role="status"
		>
			Loading repairs
		</p>
		<div
			v-else-if="list?.status === 'error'"
			class="px-4 pb-4"
		>
			<UAlert
				color="error"
				variant="subtle"
				title="The Repairs Could Not Be Loaded"
				:description="list.error?.message ?? 'Try again in a few minutes.'"
			/>
		</div>
		<p
			v-else-if="list && list.items.length === 0"
			class="px-4 pb-4 text-sm text-muted"
		>
			No automatic repairs yet
		</p>
		<ul v-else-if="list">
			<Row
				v-for="repair in list.items"
				:key="repair.id"
				:repair="repair"
				:undoing="undoing === repair.id"
				@undo="emit('undo', $event)"
			/>
		</ul>
		<div
			v-if="undoError"
			class="px-4 pb-4"
		>
			<UAlert
				color="error"
				variant="subtle"
				:description="undoError"
			/>
		</div>
		<div
			v-if="list?.nextCursor"
			class="border-t border-default px-4 py-3"
		>
			<UButton
				color="neutral"
				variant="outline"
				size="sm"
				:loading="list.status === 'loading'"
				@click="emit('loadMore')"
			>
				Show More
			</UButton>
		</div>
	</section>
</template>
