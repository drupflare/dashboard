<script setup lang="ts">
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import { useReleasesStore, type RevisionItem } from '~/stores/releases';
import type { SiteSummary } from '~/stores/sites';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Code History' });

const route = useRoute();
const siteId = String(route.params.id);
const releases = useReleasesStore();

const site = ref<SiteSummary | null>(null);
const siteError = ref<ApiClientError | null>(null);
// undefined: not loaded; an array: loaded
const items = ref<RevisionItem[] | undefined>(undefined);
const itemsError = ref<ApiClientError | null>(null);

async function loadItems(): Promise<void> {
	if (site.value === null) return;
	itemsError.value = null;
	try {
		items.value = await releases.revisions(site.value.orgId, siteId);
	} catch (failure) {
		itemsError.value = toApiClientError(failure);
	}
}

async function loadSite(): Promise<void> {
	siteError.value = null;
	try {
		site.value = await useApi().get<SiteSummary>(`/sites/${encodeURIComponent(siteId)}`);
		await loadItems();
	} catch (failure) {
		siteError.value = toApiClientError(failure);
	}
}

onMounted(() => void loadSite());

const siteMissing = computed(() => siteError.value?.status === 404);
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

			<template v-else-if="site">
				<UiPageHeader
					title="Code History"
					text="The releases and edits this site has run. Rolling back changes the code only. Your content and settings stay as they are."
				/>

				<SiteModifyForm
					:org-id="site.orgId"
					:site-id="siteId"
				/>

				<UiErrorState
					v-if="itemsError"
					title="Could Not Load the History"
					:text="itemsError.message"
					:request-id="itemsError.requestId"
				>
					<UButton
						color="neutral"
						@click="loadItems()"
						>Try Again</UButton
					>
				</UiErrorState>

				<UiSkeletonTable
					v-else-if="items === undefined"
					label="Loading the code history"
					:rows="3"
				/>

				<UiEmptyState
					v-else-if="items.length === 0"
					icon="i-lucide-history"
					title="No History Yet"
					text="Each release and edit the site runs is listed here."
				/>

				<SiteDeployTable
					v-else
					:org-id="site.orgId"
					:site-id="siteId"
					:items="items"
				/>
			</template>

			<UiSkeletonTable
				v-else
				label="Loading the site"
				:rows="3"
			/>
		</div>
		<template #fallback>
			<UiSkeletonTable
				label="Loading the site"
				:rows="3"
			/>
		</template>
	</ClientOnly>
</template>
