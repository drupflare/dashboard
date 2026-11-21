<script setup lang="ts">
import Log from '~/components/health/repair/Log.vue';
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import { useRepairsStore, type RepairView } from '~/stores/repairs';
import type { SiteSummary } from '~/stores/sites';

definePageMeta({ middleware: ['auth'] });

const route = useRoute();
const siteId = String(route.params.id);
const store = useRepairsStore();

const site = ref<SiteSummary | null>(null);
const siteError = ref<ApiClientError | null>(null);
const undoing = ref<string | null>(null);
const undoError = ref<string | null>(null);

const orgId = computed(() => site.value?.orgId ?? null);
const list = computed(() =>
	orgId.value === null ? undefined : store.listFor(orgId.value, siteId)
);

async function load(): Promise<void> {
	if (orgId.value === null) return;
	await store.load(orgId.value, siteId);
}

async function loadSite(): Promise<void> {
	siteError.value = null;
	try {
		site.value = await useApi().get<SiteSummary>(`/sites/${encodeURIComponent(siteId)}`);
		await load();
	} catch (failure) {
		siteError.value = toApiClientError(failure);
	}
}

async function undo(repair: RepairView): Promise<void> {
	if (orgId.value === null) return;
	undoing.value = repair.id;
	undoError.value = null;
	try {
		await store.undo(orgId.value, siteId, repair.id, crypto.randomUUID());
		await store.reload(orgId.value, siteId);
	} catch (failure) {
		undoError.value = toApiClientError(failure).message;
	} finally {
		undoing.value = null;
	}
}

function loadMore(): void {
	if (orgId.value !== null) void store.loadMore(orgId.value, siteId);
}

onMounted(() => {
	void loadSite();
});

useHead({ title: () => (site.value ? `Repairs for ${site.value.name}` : 'Repairs') });
</script>

<template>
	<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
		<header>
			<h1 class="text-2xl font-bold">Automatic Repairs</h1>
			<p class="text-sm text-muted">
				Each repair the platform made on this site, what it saw before and after, and
				whether you can undo it.
			</p>
		</header>
		<UAlert
			v-if="siteError"
			color="error"
			variant="subtle"
			title="The Site Could Not Be Loaded"
			:description="siteError.message"
		/>
		<Log
			v-else
			:list="list"
			:undoing="undoing"
			:undo-error="undoError"
			@load-more="loadMore"
			@undo="undo"
		/>
	</div>
</template>
