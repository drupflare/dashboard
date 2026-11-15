<script setup lang="ts">
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import { useBackupsStore } from '~/stores/backups';
import type { SiteSummary } from '~/stores/sites';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Restore Points' });

const route = useRoute();
const siteId = String(route.params.id);
const backups = useBackupsStore();

const site = ref<SiteSummary | null>(null);
const siteError = ref<ApiClientError | null>(null);
const pitrOpen = ref(false);

async function loadSite(): Promise<void> {
	siteError.value = null;
	try {
		site.value = await useApi().get<SiteSummary>(`/sites/${encodeURIComponent(siteId)}`);
		await backups.loadRestorePoints(site.value.orgId, siteId);
	} catch (failure) {
		siteError.value = toApiClientError(failure);
	}
}

onMounted(() => void loadSite());

const siteMissing = computed(() => siteError.value?.status === 404);
const list = computed(() =>
	site.value ? backups.restorePointsFor(site.value.orgId, siteId) : undefined
);
const pitrOffered = computed(
	() => list.value?.layers.some((layer) => layer.layer === 'pitr') ?? false
);
</script>

<template>
	<ClientOnly>
		<div class="flex max-w-3xl flex-col gap-8">
			<UiEmptyState
				v-if="siteMissing"
				icon="i-lucide-search-x"
				title="Site Not Found"
				text="Check the link, or pick a site from your list."
			>
				<UButton
					color="neutral"
					to="/sites"
				>
					Back to Sites
				</UButton>
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
				>
					Try Again
				</UButton>
			</UiErrorState>

			<template v-else-if="site">
				<UiPageHeader
					title="Restore Points"
					text="Saved copies and moments this site can return to. Each one lists what it brings back and what it leaves out."
				>
					<UButton
						v-if="pitrOffered"
						color="neutral"
						variant="outline"
						icon="i-lucide-history"
						@click="pitrOpen = true"
						>Restore to a Moment</UButton
					>
				</UiPageHeader>

				<UiSkeletonTable
					v-if="!list || (list.status === 'loading' && list.items.length === 0)"
					label="Loading restore points"
					:rows="3"
				/>

				<UiErrorState
					v-else-if="list.status === 'error' && list.items.length === 0"
					title="Could Not Load Restore Points"
					:text="list.error?.message"
					:request-id="list.error?.requestId"
				>
					<UButton
						color="neutral"
						@click="backups.reloadRestorePoints(site.orgId, siteId)"
						>Try Again</UButton
					>
				</UiErrorState>

				<UiEmptyState
					v-else-if="list.items.length === 0 && list.layers.length === 0"
					icon="i-lucide-history"
					title="No Restore Points Yet"
					text="Saved copies and moments appear here once the site has one."
				/>

				<template v-else>
					<SiteBackupPoints
						:points="list.items"
						:layers="list.layers"
					/>

					<div
						v-if="list.status === 'error'"
						class="flex flex-wrap items-center gap-3"
					>
						<p
							role="alert"
							class="text-sm text-red-700 dark:text-red-400"
						>
							{{ list.error?.message }}
						</p>
						<UButton
							color="neutral"
							variant="outline"
							@click="backups.loadMoreRestorePoints(site.orgId, siteId)"
							>Try Again</UButton
						>
					</div>
					<UButton
						v-else-if="list.nextCursor"
						color="neutral"
						variant="outline"
						class="self-start"
						:loading="list.status === 'loading'"
						@click="backups.loadMoreRestorePoints(site.orgId, siteId)"
						>Load More</UButton
					>
				</template>

				<SiteBackupPitr
					v-if="pitrOpen"
					:org-id="site.orgId"
					:site-id="siteId"
					@close="pitrOpen = false"
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
