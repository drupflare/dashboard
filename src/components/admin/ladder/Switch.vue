<script setup lang="ts">
import { GLOBAL_CONFIRMATION } from '~/shared/health/repair-copy';
import type { LadderScope, LadderSwitch } from '~/stores/admin-ladder';

const props = defineProps<{ switches: LadderSwitch[]; busy: boolean; error: string | null }>();
const emit = defineEmits<{
	save: [input: { scope: LadderScope; scopeId: string; auto: boolean; confirmation?: string }];
}>();

const scope = ref<LadderScope>('site');
const scopeId = ref('');
const auto = ref(false);
const confirmation = ref('');

const isGlobal = computed(() => scope.value === 'global');
const canSave = computed(() =>
	isGlobal.value ? confirmation.value === GLOBAL_CONFIRMATION : scopeId.value.trim() !== ''
);

function save(): void {
	if (!canSave.value || props.busy) return;
	if (isGlobal.value) {
		emit('save', {
			scope: 'global',
			scopeId: '',
			auto: auto.value,
			confirmation: confirmation.value
		});
		return;
	}
	emit('save', { scope: scope.value, scopeId: scopeId.value.trim(), auto: auto.value });
}
</script>

<template>
	<form
		class="flex flex-col gap-4 rounded-lg border border-default p-4"
		aria-labelledby="ladder-switch-title"
		@submit.prevent="save"
	>
		<h2
			id="ladder-switch-title"
			class="text-lg font-semibold"
		>
			Automatic Repair Switch
		</h2>
		<label class="flex flex-col gap-1 text-sm">
			<span class="font-medium">Scope</span>
			<select
				v-model="scope"
				class="rounded-md border border-default bg-default px-3 py-2"
			>
				<option value="site">Site</option>
				<option value="organization">Organization</option>
				<option value="global">Everything</option>
			</select>
		</label>
		<label
			v-if="!isGlobal"
			class="flex flex-col gap-1 text-sm"
		>
			<span class="font-medium">Scope Id</span>
			<input
				v-model="scopeId"
				type="text"
				class="rounded-md border border-default bg-default px-3 py-2"
				autocomplete="off"
			/>
		</label>
		<label class="flex items-center gap-2 text-sm">
			<input
				v-model="auto"
				type="checkbox"
			/>
			<span>Automatic repair on for this scope</span>
		</label>
		<label
			v-if="isGlobal"
			class="flex flex-col gap-1 text-sm"
		>
			<span class="font-medium">Type {{ GLOBAL_CONFIRMATION }} to change everything</span>
			<input
				v-model="confirmation"
				type="text"
				class="rounded-md border border-default bg-default px-3 py-2"
				autocomplete="off"
			/>
		</label>
		<UAlert
			v-if="error"
			color="error"
			variant="subtle"
			:description="error"
		/>
		<div>
			<UButton
				type="submit"
				:loading="busy"
				:disabled="!canSave || busy"
			>
				Save Switch
			</UButton>
		</div>
		<ul class="text-sm text-muted">
			<li
				v-for="item in switches"
				:key="`${item.scope}/${item.scopeId}`"
			>
				{{ item.scope }}{{ item.scopeId ? ` ${item.scopeId}` : '' }}:
				{{ item.auto ? 'On' : 'Off' }}
			</li>
		</ul>
	</form>
</template>
