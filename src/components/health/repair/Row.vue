<script setup lang="ts">
import type { RepairView } from '~/stores/repairs';
import Undo from './Undo.vue';

const props = defineProps<{ repair: RepairView; undoing: boolean }>();
const emit = defineEmits<{ undo: [repair: RepairView] }>();

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const when = computed(() => dateFormat.format(new Date(props.repair.createdAt)));

const icon = computed(() => {
	switch (props.repair.status) {
		case 'succeeded':
			return 'i-lucide-circle-check';
		case 'failed':
			return 'i-lucide-circle-alert';
		case 'refused':
			return 'i-lucide-ban';
		case 'undone':
			return 'i-lucide-undo-2';
		default:
			return 'i-lucide-loader-circle';
	}
});
</script>

<template>
	<li class="flex flex-col gap-2 border-t border-default px-4 py-4">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<h3 class="font-medium">{{ repair.title }}</h3>
			<time
				class="text-sm text-muted"
				:datetime="repair.createdAt"
				>{{ when }}</time
			>
		</div>
		<p class="inline-flex items-center gap-1.5 text-sm">
			<UIcon
				:name="icon"
				class="size-4 shrink-0"
				aria-hidden="true"
			/>
			<span>{{ repair.statusText }}</span>
		</p>
		<dl class="grid gap-1 text-sm">
			<div>
				<dt class="inline font-medium">Seen before:</dt>
				<dd class="inline">{{ repair.before }}</dd>
			</div>
			<div v-if="repair.after">
				<dt class="inline font-medium">After:</dt>
				<dd class="inline">{{ repair.after }}</dd>
			</div>
		</dl>
		<Undo
			:repair="repair"
			:busy="undoing"
			@confirm="emit('undo', $event)"
		/>
	</li>
</template>
