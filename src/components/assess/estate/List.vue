<script setup lang="ts">
import type { AssessmentView } from '~/shared/estate-view';

defineProps<{
	items: AssessmentView[];
	nextCursor: string | null;
	loaded: boolean;
	loading: boolean;
	error: string | null;
}>();
const emit = defineEmits<{ more: [] }>();

const STATE_LABELS: Record<AssessmentView['state'], string> = {
	preparing: 'Preparing',
	running: 'In Progress',
	finished: 'Finished',
	cancelled: 'Cancelled',
	failed: 'Could Not Finish'
};
</script>

<template>
	<div class="flex flex-col gap-4">
		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>

		<div
			v-else-if="!loaded"
			role="status"
			class="flex flex-col gap-3"
		>
			<span class="sr-only">Loading the assessments</span>
			<USkeleton class="h-16 w-full" />
		</div>

		<p
			v-else-if="items.length === 0"
			class="text-sm text-muted"
		>
			You have not run an assessment yet. Check an inventory below to start one.
		</p>

		<ul
			v-else
			class="flex flex-col gap-3"
		>
			<li
				v-for="view in items"
				:key="view.id"
				class="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-default p-4"
			>
				<div class="flex flex-col gap-1">
					<p class="font-medium text-highlighted">{{ STATE_LABELS[view.state] }}</p>
					<p class="text-sm text-muted">
						Started {{ new Date(view.createdAt).toLocaleString() }}
					</p>
				</div>
				<dl class="flex gap-6 text-sm">
					<div class="flex flex-col gap-1">
						<dt class="text-muted">Sites</dt>
						<dd class="font-semibold tabular-nums text-highlighted">
							{{ view.rowCount }}
						</dd>
					</div>
					<div class="flex flex-col gap-1">
						<dt class="text-muted">Rejected Rows</dt>
						<dd class="font-semibold tabular-nums text-highlighted">
							{{ view.rejectedTotal }}
						</dd>
					</div>
				</dl>
				<UButton
					:to="`/assess/estate/${encodeURIComponent(view.id)}`"
					color="neutral"
					variant="outline"
				>
					View the Report
				</UButton>
			</li>
		</ul>

		<div v-if="nextCursor">
			<UButton
				color="neutral"
				variant="outline"
				:loading="loading"
				:disabled="loading"
				@click="emit('more')"
			>
				Load More Assessments
			</UButton>
		</div>
	</div>
</template>
