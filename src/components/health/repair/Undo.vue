<script setup lang="ts">
import type { RepairView } from '~/stores/repairs';

const props = defineProps<{ repair: RepairView; busy: boolean }>();
const emit = defineEmits<{ confirm: [repair: RepairView] }>();

const asking = ref(false);
</script>

<template>
	<div
		v-if="repair.canUndo"
		class="flex flex-col items-start gap-2"
	>
		<UButton
			v-if="!asking"
			color="neutral"
			variant="outline"
			size="sm"
			icon="i-lucide-undo-2"
			:aria-label="`Undo Repair: ${repair.title}`"
			@click="asking = true"
		>
			Undo Repair
		</UButton>
		<div
			v-else
			class="flex flex-wrap items-center gap-2"
		>
			<span class="text-sm">Undo this repair? The undo appears in this list.</span>
			<UButton
				color="error"
				size="sm"
				:loading="busy"
				:disabled="busy"
				@click="emit('confirm', repair)"
			>
				Confirm Undo
			</UButton>
			<UButton
				color="neutral"
				variant="ghost"
				size="sm"
				:disabled="busy"
				@click="asking = false"
			>
				Cancel
			</UButton>
		</div>
	</div>
	<p
		v-else-if="repair.undoReason"
		class="text-xs text-muted"
	>
		{{ repair.undoReason }}
	</p>
</template>
