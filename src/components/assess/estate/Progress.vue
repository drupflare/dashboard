<script setup lang="ts">
import type { AssessmentView } from '~/shared/estate-view';

const props = defineProps<{ view: AssessmentView }>();

const status = computed(() => {
	const { state, rowCount, progress } = props.view;
	const done = rowCount - progress.pending - progress.checking;
	switch (state) {
		case 'preparing':
			return {
				title: 'Preparing',
				text: 'Reading the inventory. No site has been checked yet.'
			};
		case 'running':
			return {
				title: `Checking ${done} of ${rowCount}`,
				text: 'Sites are checked a few at a time. This page updates as they finish.'
			};
		case 'finished':
			return { title: 'Finished', text: 'Every site in this assessment has been checked.' };
		case 'cancelled':
			return {
				title: 'Cancelled',
				text: 'Sites already checked keep their results. The rest were skipped.'
			};
		default:
			return {
				title: 'Could Not Finish',
				text: 'The assessment stopped before every site was checked. Start a new assessment to try again.'
			};
	}
});
</script>

<template>
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold text-highlighted">{{ status.title }}</h2>
		<p class="text-sm text-muted">{{ status.text }}</p>
	</div>
</template>
