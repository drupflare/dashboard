<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import {
	DEPARTMENT_KIND_LABEL,
	DEPARTMENT_KINDS,
	MAX_DEPARTMENT_DEPTH,
	type DepartmentKind,
	type DepartmentView
} from '~/shared/departments';
import { useDepartmentsStore } from '~/stores/departments';

const props = defineProps<{ orgId: string; departments: DepartmentView[] }>();
const emit = defineEmits<{ created: [department: DepartmentView] }>();

const store = useDepartmentsStore();

// reka-ui rejects an empty string as a select value
const NONE = 'none';
const open = ref(false);
const trigger = useTemplateRef<{ $el: HTMLElement }>('trigger');
const name = ref('');
const kind = ref<DepartmentKind>('department');
const parentId = ref(NONE);
const busy = ref(false);
const error = ref<string | null>(null);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const depthOf = (id: string): number => {
	const byId = new Map(props.departments.map((d) => [d.id, d]));
	let depth = 1;
	let at = byId.get(id)?.parentId ?? null;
	while (at !== null && depth <= MAX_DEPARTMENT_DEPTH) {
		depth++;
		at = byId.get(at)?.parentId ?? null;
	}
	return depth;
};

// the server checks every rule; the list only leaves out parents it would refuse
const parents = computed(() => [
	{ label: 'None (Top Level)', value: NONE },
	...props.departments
		.filter((d) => depthOf(d.id) < MAX_DEPARTMENT_DEPTH)
		.filter((d) => kind.value === 'department' || d.kind === 'division')
		.map((d) => ({ label: d.name, value: d.id }))
]);

const kinds = DEPARTMENT_KINDS.map((value) => ({ label: DEPARTMENT_KIND_LABEL[value], value }));

watch(kind, () => {
	if (!parents.value.some((p) => p.value === parentId.value)) parentId.value = NONE;
});

function show(): void {
	name.value = '';
	kind.value = 'department';
	parentId.value = NONE;
	error.value = null;
	open.value = true;
}

watch(open, (value) => {
	if (!value) void nextTick(() => trigger.value?.$el.focus());
});

async function submit(): Promise<void> {
	error.value = null;
	const label = name.value.trim();
	if (label === '') {
		error.value = 'Enter a name for the department.';
		return;
	}
	busy.value = true;
	try {
		const created = await store.create(props.orgId, {
			name: label,
			kind: kind.value,
			parentId: parentId.value === NONE ? null : parentId.value
		});
		open.value = false;
		emit('created', created);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div>
		<UButton
			ref="trigger"
			icon="i-lucide-plus"
			@click="show()"
			>Create a Department</UButton
		>
		<UModal
			v-model:open="open"
			title="Create a Department"
			description="A division groups departments. Departments can sit four levels deep."
		>
			<template #body>
				<form
					class="flex flex-col gap-4"
					@submit.prevent="submit()"
				>
					<UiField
						id="department-name"
						label="Name"
						v-slot="{ describedBy }"
					>
						<input
							id="department-name"
							v-model="name"
							type="text"
							maxlength="80"
							autocomplete="off"
							aria-required="true"
							:class="inputClass"
							:aria-describedby="describedBy"
						/>
					</UiField>
					<UFormField label="Type">
						<USelect
							v-model="kind"
							:items="kinds"
							aria-label="Type"
							class="w-full"
						/>
					</UFormField>
					<UFormField label="Inside">
						<USelect
							v-model="parentId"
							:items="parents"
							aria-label="Inside"
							class="w-full"
						/>
					</UFormField>
					<p
						v-if="error"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ error }}
					</p>
					<div class="flex gap-3">
						<UButton
							type="submit"
							:loading="busy"
							>Create</UButton
						>
						<UButton
							type="button"
							color="neutral"
							variant="outline"
							@click="open = false"
							>Cancel</UButton
						>
					</div>
				</form>
			</template>
		</UModal>
	</div>
</template>
