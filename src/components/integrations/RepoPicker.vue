<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { useRepoConnectionsStore } from '~/stores/repo-connections';

const props = defineProps<{ orgId: string; connectionId: string }>();
const model = defineModel<string>();

const repo = useRepoConnectionsStore();
const loading = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);

const items = computed(() =>
	(repo.repositories.get(props.connectionId) ?? []).map((item) => ({
		label: item.fullName,
		value: item.fullName
	}))
);

async function load(): Promise<void> {
	error.value = null;
	loading.value = true;
	try {
		await repo.loadRepositories(props.orgId, props.connectionId);
		loaded.value = true;
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		loading.value = false;
	}
}

watch(() => props.connectionId, load, { immediate: true });
</script>

<template>
	<div class="flex flex-col gap-2">
		<USelect
			v-model="model"
			:items="items"
			:loading="loading"
			:disabled="loading || items.length === 0"
			placeholder="Choose a repository"
			class="w-full"
		/>
		<p
			v-if="error"
			role="alert"
			class="flex flex-wrap items-center gap-2 text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
			<UButton
				color="neutral"
				variant="link"
				@click="load()"
				>Try Again</UButton
			>
		</p>
		<p
			v-else-if="loaded && !loading && items.length === 0"
			class="text-sm text-muted"
		>
			This connection can read no repositories. Check its access on the provider, then try
			again.
		</p>
	</div>
</template>
