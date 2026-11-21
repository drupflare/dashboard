<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import {
	CLASSIFICATION_LABEL,
	type Classification,
	type ClassificationEntry,
	type PolicyGroupView
} from '~/shared/policies';
import { usePoliciesStore } from '~/stores/policies';

const props = defineProps<{
	orgId: string;
	entries: ClassificationEntry[];
	groups: PolicyGroupView[];
}>();

const store = usePoliciesStore();
const names = reactive<Record<string, string>>(
	Object.fromEntries(props.entries.map((e) => [e.label, e.displayName ?? '']))
);
const error = ref<string | null>(null);
const busy = ref(false);

const NONE = 'none';
const options = computed(() => [
	{ label: 'No Default Group', value: NONE },
	...props.groups.map((g) => ({ label: g.name, value: g.id }))
]);

async function run(work: () => Promise<void>): Promise<void> {
	error.value = null;
	busy.value = true;
	try {
		await work();
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}

const saveName = (label: Classification) =>
	run(() => store.nameLabel(props.orgId, label, (names[label] ?? '').trim() || null));

// choosing no group takes the label's current group off it
const pick = (entry: ClassificationEntry, value: string) =>
	run(async () => {
		if (value === NONE) {
			if (entry.policyId !== null) {
				await store.unassign(props.orgId, entry.policyId, {
					kind: 'classification',
					targetId: entry.label
				});
			}
			return;
		}
		await store.assign(props.orgId, value, { kind: 'classification', targetId: entry.label });
	});
</script>

<template>
	<div class="flex flex-col gap-3">
		<ul class="flex flex-col gap-3">
			<li
				v-for="entry in entries"
				:key="entry.label"
				class="flex flex-wrap items-end gap-3"
			>
				<span class="w-28 text-sm font-medium text-highlighted">{{
					CLASSIFICATION_LABEL[entry.label]
				}}</span>
				<UFormField label="Your Name for It">
					<input
						v-model="names[entry.label]"
						type="text"
						maxlength="60"
						:aria-label="`Your name for ${CLASSIFICATION_LABEL[entry.label]}`"
						class="rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
						@change="saveName(entry.label)"
					/>
				</UFormField>
				<UFormField label="Default Policy Group">
					<USelect
						:model-value="entry.policyId ?? NONE"
						:items="options"
						:aria-label="`Default policy group for ${CLASSIFICATION_LABEL[entry.label]}`"
						@update:model-value="(v: string) => pick(entry, v)"
					/>
				</UFormField>
			</li>
		</ul>
		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>
	</div>
</template>
