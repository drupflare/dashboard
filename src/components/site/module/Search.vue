<script setup lang="ts">
import { MODULE_STATES, type ModuleState } from '~/shared/modules';

const q = defineModel<string>('q', { required: true });
const state = defineModel<ModuleState | undefined>('state', { required: true });

const stateItems = [
	{ label: 'Any State', value: 'any' },
	...MODULE_STATES.map((value) => ({ label: stateLabel(value), value }))
];

function stateLabel(value: ModuleState): string {
	if (value === 'verified') return 'Verified';
	if (value === 'untested') return 'Untested';
	return 'Blocked';
}

const selected = computed({
	get: () => state.value ?? 'any',
	set: (value: string) => {
		state.value = value === 'any' ? undefined : (value as ModuleState);
	}
});
</script>

<template>
	<div class="flex flex-col gap-3 sm:flex-row sm:items-end">
		<UFormField
			label="Search Modules"
			class="flex-1"
		>
			<UInput
				v-model="q"
				placeholder="Name or title"
				icon="i-lucide-search"
				class="w-full"
			/>
		</UFormField>
		<UFormField label="State">
			<USelect
				v-model="selected"
				:items="stateItems"
				class="w-full sm:w-48"
			/>
		</UFormField>
	</div>
</template>
