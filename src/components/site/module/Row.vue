<script setup lang="ts">
import type { ModuleListItem } from '~/shared/modules';

const props = defineProps<{ row: ModuleListItem; checking: boolean }>();
const emit = defineEmits<{
	check: [row: ModuleListItem];
	enable: [row: ModuleListItem];
	remove: [row: ModuleListItem];
}>();

const confirming = ref(false);
const removing = ref(false);

const status = computed(() => {
	if (props.row.shipping) {
		return { icon: 'i-lucide-package-check', text: 'Included', tone: 'text-success' };
	}
	if (props.row.state === 'verified') {
		return { icon: 'i-lucide-badge-check', text: 'Verified', tone: 'text-success' };
	}
	if (props.row.state === 'untested') {
		return { icon: 'i-lucide-circle-help', text: 'Untested', tone: 'text-warning' };
	}
	return { icon: 'i-lucide-ban', text: 'Blocked', tone: 'text-error' };
});

function onCheck() {
	if (props.row.state === 'untested' && !confirming.value) {
		confirming.value = true;
		return;
	}
	confirming.value = false;
	emit('check', props.row);
}

function onRemove() {
	if (!removing.value) {
		removing.value = true;
		return;
	}
	removing.value = false;
	emit('remove', props.row);
}
</script>

<template>
	<li class="flex flex-col gap-2 border-t border-default px-4 py-3 sm:flex-row sm:items-center">
		<div class="min-w-0 flex-1">
			<p class="font-medium">{{ row.label }}</p>
			<p class="truncate text-sm text-muted">{{ row.name }}</p>
			<p
				v-if="row.state === 'blocked' && row.reason"
				class="text-sm text-muted"
			>
				{{ row.reason }}
			</p>
			<p
				v-if="confirming"
				class="text-sm text-muted"
			>
				This module has never been run on a site. Checking it does not install anything.
			</p>
			<p
				v-if="removing"
				class="text-sm text-muted"
			>
				This turns {{ row.label }} off and removes it. A restore point is taken first.
			</p>
		</div>
		<span
			class="inline-flex items-center gap-1.5 text-sm"
			:class="status.tone"
		>
			<UIcon
				:name="status.icon"
				class="size-4"
				aria-hidden="true"
			/>
			{{ status.text }}
		</span>
		<div class="flex flex-wrap gap-2 sm:w-72 sm:justify-end">
			<UButton
				v-if="row.shipping"
				label="Included"
				color="neutral"
				variant="ghost"
				disabled
			/>
			<UButton
				v-else-if="row.state === 'blocked'"
				label="Check"
				color="neutral"
				variant="outline"
				disabled
			/>
			<UButton
				v-else
				:label="confirming ? 'Check Anyway' : 'Check'"
				:loading="checking"
				variant="outline"
				@click="onCheck"
			/>
			<UButton
				v-if="row.shipping"
				label="Enable"
				variant="outline"
				@click="emit('enable', row)"
			/>
			<UButton
				v-if="row.state !== 'blocked'"
				:label="removing ? 'Confirm Remove' : 'Remove'"
				color="neutral"
				variant="ghost"
				@click="onRemove"
			/>
		</div>
	</li>
</template>
