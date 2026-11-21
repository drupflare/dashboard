<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import type { DepartmentView, PlacementSite } from '~/shared/departments';
import {
	ASSIGNMENT_KINDS,
	CLASSIFICATIONS,
	CLASSIFICATION_LABEL,
	type AssignmentKind,
	type PolicyGroupView
} from '~/shared/policies';
import { usePoliciesStore } from '~/stores/policies';

const props = defineProps<{
	orgId: string;
	group: PolicyGroupView;
	departments: DepartmentView[];
	sites: PlacementSite[];
}>();

const store = usePoliciesStore();
const kind = ref<AssignmentKind>('organization');
const target = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

const KIND_LABEL: Record<AssignmentKind, string> = {
	organization: 'Whole Organization',
	department: 'Department',
	site: 'Site',
	classification: 'Classification'
};
const kinds = ASSIGNMENT_KINDS.map((value) => ({ label: KIND_LABEL[value], value }));

const targets = computed(() => {
	switch (kind.value) {
		case 'department':
			return props.departments.map((d) => ({ label: d.name, value: d.id }));
		case 'site':
			return props.sites.map((s) => ({ label: s.name, value: s.id }));
		case 'classification':
			return CLASSIFICATIONS.map((value) => ({ label: CLASSIFICATION_LABEL[value], value }));
		default:
			return [{ label: 'This Organization', value: props.orgId }];
	}
});

watch(kind, () => {
	target.value = kind.value === 'organization' ? props.orgId : '';
});

function nameOf(a: { kind: AssignmentKind; targetId: string }): string {
	if (a.kind === 'organization') return 'The whole organization';
	if (a.kind === 'classification') {
		return `Classification ${CLASSIFICATION_LABEL[a.targetId as keyof typeof CLASSIFICATION_LABEL] ?? a.targetId}`;
	}
	const list = a.kind === 'department' ? props.departments : props.sites;
	return `${KIND_LABEL[a.kind]} ${list.find((x) => x.id === a.targetId)?.name ?? a.targetId}`;
}

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

const add = () =>
	run(async () => {
		const id = kind.value === 'organization' ? props.orgId : target.value;
		if (id === '') {
			error.value = 'Choose where this group applies.';
			return;
		}
		await store.assign(props.orgId, props.group.id, { kind: kind.value, targetId: id });
	});

const remove = (a: { kind: AssignmentKind; targetId: string }) =>
	run(() => store.unassign(props.orgId, props.group.id, a));
</script>

<template>
	<div class="flex flex-col gap-3">
		<p
			v-if="group.assignments.length === 0"
			class="text-sm text-muted"
		>
			This group applies nowhere yet.
		</p>
		<ul
			v-else
			class="flex flex-col gap-1"
		>
			<li
				v-for="a in group.assignments"
				:key="`${a.kind}/${a.targetId}`"
				class="flex items-center justify-between gap-3 text-sm text-default"
			>
				<span class="wrap-break-word">{{ nameOf(a) }}</span>
				<UButton
					size="xs"
					color="neutral"
					variant="outline"
					:disabled="busy"
					:aria-label="`Remove ${nameOf(a)}`"
					@click="remove(a)"
					>Remove</UButton
				>
			</li>
		</ul>
		<div class="flex flex-wrap items-end gap-3">
			<UFormField label="Applies To">
				<USelect
					v-model="kind"
					:items="kinds"
					aria-label="Applies To"
				/>
			</UFormField>
			<UFormField
				v-if="kind !== 'organization'"
				label="Target"
			>
				<USelect
					v-model="target"
					:items="targets"
					aria-label="Target"
					placeholder="Choose"
				/>
			</UFormField>
			<UButton
				:loading="busy"
				@click="add()"
				>Assign</UButton
			>
		</div>
		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>
	</div>
</template>
