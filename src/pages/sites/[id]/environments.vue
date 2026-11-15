<script setup lang="ts">
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import { ENVIRONMENT_KIND_LABELS } from '~/shared/environments';
import { useEnvironmentsStore, type SiteEnvironment } from '~/stores/environments';
import type { SiteSummary } from '~/stores/sites';

definePageMeta({ middleware: ['auth'] });

const route = useRoute();
const siteId = String(route.params.id);
const store = useEnvironmentsStore();

const site = ref<SiteSummary | null>(null);
const siteError = ref<ApiClientError | null>(null);
const creating = ref(false);
const confirming = ref<SiteEnvironment | null>(null);
const deleting = ref<string | null>(null);
const deleteError = ref<string | null>(null);

const orgId = computed(() => site.value?.orgId ?? null);
const list = computed(() =>
	orgId.value === null ? undefined : store.listFor(orgId.value, siteId)
);
const items = computed(() => list.value?.items ?? []);
const taken = computed(() => new Set(items.value.map((item) => item.kind)));
const siteMissing = computed(() => siteError.value?.status === 404);

async function loadSite(): Promise<void> {
	siteError.value = null;
	try {
		site.value = await useApi().get<SiteSummary>(`/sites/${encodeURIComponent(siteId)}`);
		await store.load(site.value.orgId, siteId);
	} catch (failure) {
		siteError.value = toApiClientError(failure);
	}
}

onMounted(() => void loadSite());

// a copy that is being made or removed changes on its own, so the list is read again while one runs
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
	timer = setInterval(() => {
		const org = orgId.value;
		const running = items.value.some(
			(item) => item.status === 'creating' || item.status === 'deleting'
		);
		if (org !== null && running && document.visibilityState !== 'hidden') {
			void store.reload(org, siteId);
		}
	}, 10_000);
});
onBeforeUnmount(() => clearInterval(timer));

useHead({ title: () => (site.value ? `Environments for ${site.value.name}` : 'Environments') });

async function remove(environment: SiteEnvironment): Promise<void> {
	const org = orgId.value;
	if (org === null) return;
	deleteError.value = null;
	deleting.value = environment.id;
	try {
		const operation = await store.remove(org, siteId, environment.id, crypto.randomUUID());
		confirming.value = null;
		await navigateTo(`/new/progress/${operation.id}`);
	} catch (cause) {
		deleteError.value = toApiClientError(cause).message;
	} finally {
		deleting.value = null;
	}
}
</script>

<template>
	<ClientOnly>
		<div class="flex max-w-3xl flex-col gap-6">
			<UiEmptyState
				v-if="siteMissing"
				icon="i-lucide-search-x"
				title="Site Not Found"
				text="Check the link, or pick a site from your list."
			>
				<UButton
					color="neutral"
					to="/sites"
					>Back to Sites</UButton
				>
			</UiEmptyState>

			<UiErrorState
				v-else-if="siteError"
				title="Could Not Load the Site"
				:text="siteError.message"
				:request-id="siteError.requestId"
			>
				<UButton
					color="neutral"
					@click="loadSite()"
					>Try Again</UButton
				>
			</UiErrorState>

			<SiteSkeleton v-else-if="!site" />

			<template v-else>
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div class="flex flex-col gap-1">
						<h1 class="text-2xl font-semibold text-highlighted">
							Environments for {{ site.name }}
						</h1>
						<p class="text-sm text-default">
							A staging or dev copy lets you try a change before it reaches the live
							site. A preview is a temporary copy that deletes itself.
						</p>
					</div>
					<UButton
						icon="i-lucide-plus"
						@click="creating = true"
						>Create Environment</UButton
					>
				</div>

				<UiSkeletonTable
					v-if="!list || (list.status === 'loading' && items.length === 0)"
					label="Loading environments"
					:rows="2"
				/>

				<UiErrorState
					v-else-if="list.status === 'error'"
					title="Could Not Load Environments"
					:text="list.error?.message"
					:request-id="list.error?.requestId"
				>
					<UButton
						color="neutral"
						@click="orgId && store.reload(orgId, siteId)"
						>Try Again</UButton
					>
				</UiErrorState>

				<template v-else>
					<UiEmptyState
						v-if="items.length === 0"
						icon="i-lucide-layers"
						title="No Environments Yet"
						text="Create a staging or dev copy from the newest backup of this site."
					/>
					<SiteEnvironmentSwitcher
						:site-name="site.name"
						:site-host="site.primaryHostname"
						:environments="items"
						:deleting="deleting"
						@remove="confirming = $event"
					/>
				</template>

				<div
					v-if="confirming"
					class="flex flex-col gap-3 rounded-lg border border-default p-4"
					data-test="confirm-delete"
				>
					<p class="text-sm text-default">
						Delete the {{ ENVIRONMENT_KIND_LABELS[confirming.kind] }} copy at
						{{ confirming.host }}? The live site is not touched. This cannot be undone.
					</p>
					<div class="flex gap-3">
						<UButton
							:loading="deleting === confirming.id"
							:disabled="deleting !== null"
							@click="remove(confirming)"
							>Delete Environment</UButton
						>
						<UButton
							color="neutral"
							variant="outline"
							@click="confirming = null"
							>Cancel</UButton
						>
					</div>
				</div>
				<p
					v-if="deleteError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ deleteError }}
				</p>

				<SiteEnvironmentCreate
					v-if="creating && orgId"
					:org-id="orgId"
					:site-id="siteId"
					:taken="taken"
					@close="creating = false"
				/>
			</template>
		</div>
	</ClientOnly>
</template>
