<script setup lang="ts">
import type { ConnectionView } from '~/shared/repo-connections';
import {
	PROVIDER_LABELS,
	useRepoConnectionsStore,
	type RemoteInput
} from '~/stores/repo-connections';

const props = defineProps<{
	orgId: string;
	connections: ConnectionView[];
	busy: boolean;
	error: string | null;
}>();
const emit = defineEmits<{ attach: [input: RemoteInput] }>();

type Field = 'repo' | 'branch' | 'mountPath' | 'interval';

const repo = useRepoConnectionsStore();
const connectionId = ref<string>();
const repoName = ref<string>();
const branch = ref('');
const mountPath = ref('');
const interval = ref('60');
const errors = ref<Partial<Record<Field, string>>>({});

const connectionItems = computed(() =>
	props.connections.map((item) => ({
		label: `${PROVIDER_LABELS[item.provider]}: ${item.displayName}`,
		value: item.id
	}))
);

watch(
	() => props.connections,
	(list) => {
		if (!list.some((item) => item.id === connectionId.value)) connectionId.value = list[0]?.id;
	},
	{ immediate: true }
);

// a new connection holds other repositories, so the old pick goes
watch(connectionId, () => {
	repoName.value = undefined;
});

// the branch follows the repository's default, which the person can still change
watch(repoName, (name) => {
	const found = repo.repositories
		.get(connectionId.value ?? '')
		?.find((item) => item.fullName === name);
	branch.value = found?.defaultBranch ?? '';
});

function check(): RemoteInput | null {
	const connection = connectionId.value;
	const name = repoName.value;
	const path = mountPath.value.trim();
	const minutes = Number(interval.value);
	const next: Partial<Record<Field, string>> = {};
	if (!name) next.repo = 'Choose a repository.';
	if (!branch.value.trim()) next.branch = 'Enter a branch name.';
	if (!path) next.mountPath = 'Enter a path such as modules/custom/example.';
	else if (!/^(modules|themes|profiles)\//.test(path))
		next.mountPath = 'Start the path with modules, themes or profiles.';
	if (!Number.isInteger(minutes) || minutes < 5)
		next.interval = 'Enter a whole number of minutes, 5 or more.';
	errors.value = next;
	if (!connection || !name || Object.keys(next).length > 0) return null;
	return {
		connectionId: connection,
		repo: name,
		branch: branch.value.trim(),
		mountPath: path,
		intervalMinutes: minutes
	};
}

function submit(): void {
	const input = check();
	if (input) emit('attach', input);
}
</script>

<template>
	<form
		novalidate
		class="flex flex-col gap-4"
		@submit.prevent="submit()"
	>
		<UFormField label="Connection">
			<USelect
				v-model="connectionId"
				:items="connectionItems"
				class="w-full"
			/>
		</UFormField>
		<UFormField
			label="Repository"
			:error="errors.repo"
		>
			<IntegrationsRepoPicker
				v-if="connectionId"
				v-model="repoName"
				:org-id="orgId"
				:connection-id="connectionId"
			/>
		</UFormField>
		<UFormField
			label="Branch"
			:error="errors.branch"
		>
			<UInput
				v-model="branch"
				class="w-full"
			/>
		</UFormField>
		<UFormField
			label="Mount Path"
			description="Must sit inside modules, themes or profiles, such as modules/custom/example."
			:error="errors.mountPath"
		>
			<UInput
				v-model="mountPath"
				class="w-full"
			/>
		</UFormField>
		<UFormField
			label="Pull Every (Minutes)"
			description="Minimum 5 minutes. The default is 60 minutes."
			:error="errors.interval"
		>
			<UInput
				v-model="interval"
				type="number"
				min="5"
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
		<div>
			<UButton
				type="submit"
				:loading="busy"
				:disabled="busy"
				>Attach Repository</UButton
			>
		</div>
	</form>
</template>
