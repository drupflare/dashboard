<script setup lang="ts">
import type { Operation } from '@contracts/operations';
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import { adminUrlFor } from '~/composables/useOnboarding';
import type { SiteSummary } from '~/stores/sites';

definePageMeta({ middleware: ['auth'] });

const route = useRoute();
const siteId = String(route.params.id);

const site = ref<SiteSummary | null>(null);
const siteError = ref<ApiClientError | null>(null);
const operations = ref<Operation[] | null>(null);
const operationsError = ref<ApiClientError | null>(null);

async function loadSite(): Promise<void> {
	siteError.value = null;
	try {
		site.value = await useApi().get<SiteSummary>(`/sites/${encodeURIComponent(siteId)}`);
	} catch (failure) {
		siteError.value = toApiClientError(failure);
	}
}

async function loadOperations(): Promise<void> {
	operationsError.value = null;
	try {
		const page = await useApi().get<{ items: Operation[]; nextCursor?: string | null }>(
			`/sites/${encodeURIComponent(siteId)}/operations`
		);
		operations.value = page.items;
	} catch (failure) {
		operationsError.value = toApiClientError(failure);
	}
}

onMounted(() => {
	void loadSite();
	void loadOperations();
});

useHead({ title: () => site.value?.name ?? 'Site' });

const adminUrl = computed(() => (site.value ? adminUrlFor(site.value) : null));
const siteMissing = computed(() => siteError.value?.status === 404);

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

function when(value: string): string {
	return dateFormat.format(new Date(value));
}
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

			<SiteSkeleton v-else-if="!site" />

			<template v-else>
				<SiteHeader :site="site" />

				<div v-if="adminUrl">
					<UButton
						color="primary"
						variant="solid"
						icon="i-lucide-external-link"
						:href="adminUrl"
						target="_blank"
						rel="noopener"
					>
						Open Admin
					</UButton>
				</div>

				<SiteAdmin
					v-if="adminUrl"
					:org-id="site.orgId"
					:site-id="site.id"
					:sign-in-url="adminUrl"
					:username="site.admin.username"
					:email="site.admin.email"
				/>

				<HealthTree
					:org-id="site.orgId"
					:site-id="site.id"
				/>
				<ReadinessChecklist
					:org-id="site.orgId"
					:site-id="site.id"
				/>
				<SiteUpdate
					:org-id="site.orgId"
					:site-id="site.id"
				/>
				<SiteBackupPanel
					:org-id="site.orgId"
					:site-id="site.id"
				/>
			</template>

			<section class="flex flex-col gap-3">
				<h2 class="text-lg font-semibold text-highlighted">Recent Operations</h2>

				<UiErrorState
					v-if="operationsError"
					title="Could Not Load Operations"
					:text="operationsError.message"
					:request-id="operationsError.requestId"
				>
					<UButton
						color="neutral"
						@click="loadOperations()"
					>
						Try Again
					</UButton>
				</UiErrorState>

				<div
					v-else-if="operations === null"
					role="status"
				>
					<span class="sr-only">Loading operations</span>
					<div
						aria-hidden="true"
						class="flex flex-col divide-y divide-default rounded-lg border border-default"
					>
						<div
							v-for="row in 3"
							:key="row"
							class="flex items-center justify-between gap-3 px-4 py-3"
						>
							<USkeleton class="h-4 w-28" />
							<USkeleton class="h-4 w-20" />
							<USkeleton class="h-4 w-32" />
						</div>
					</div>
				</div>

				<UiEmptyState
					v-else-if="operations.length === 0"
					icon="i-lucide-list"
					title="No Operations Yet"
					text="Operations for this site appear here."
				/>

				<ul
					v-else
					class="flex flex-col divide-y divide-default rounded-lg border border-default"
				>
					<li
						v-for="operation in operations"
						:key="operation.id"
						class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
					>
						<span class="font-medium text-highlighted">{{ operation.type }}</span>
						<OpBadge :status="operation.status" />
						<time
							:datetime="operation.updatedAt"
							class="text-muted"
							>{{ when(operation.updatedAt) }}</time
						>
					</li>
				</ul>
			</section>

			<SiteDelete
				v-if="site"
				:org-id="site.orgId"
				:site-id="site.id"
				:name="site.name"
			/>
		</div>
		<template #fallback>
			<SiteSkeleton />
		</template>
	</ClientOnly>
</template>
