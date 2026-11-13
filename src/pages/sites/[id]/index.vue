<script setup lang="ts">
import type { Operation } from '@contracts/operations';
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import { adminUrlFor } from '~/composables/useOnboarding';
import { canRetry, operationTypeLabel, refusalReason } from '~/shared/operation-copy';
import { useCutoverStore } from '~/stores/cutover';
import { useOperationsStore } from '~/stores/operations';
import type { SiteSummary } from '~/stores/sites';

definePageMeta({ middleware: ['auth'] });

const route = useRoute();
const router = useRouter();
const siteId = String(route.params.id);
const retryError = ref<string | null>(null);
const retryingId = ref<string | null>(null);

const site = ref<SiteSummary | null>(null);
const siteError = ref<ApiClientError | null>(null);
// the server sends the plain reason of a failed row; null for every other row
const operations = ref<(Operation & { reason: string | null })[] | null>(null);
const operationsError = ref<ApiClientError | null>(null);

async function loadSite(): Promise<void> {
	siteError.value = null;
	try {
		site.value = await useApi().get<SiteSummary>(`/sites/${encodeURIComponent(siteId)}`);
	} catch (failure) {
		siteError.value = toApiClientError(failure);
	}
}

// the link shows only once the server says a cutover can run, or one already exists
const cutoverOffered = ref(false);

async function loadCutover(): Promise<void> {
	const org = site.value?.orgId;
	if (!org) return;
	try {
		const plan = await useCutoverStore().read(org, siteId);
		cutoverOffered.value = plan !== null && (plan.available || plan.cutover !== null);
	} catch {
		cutoverOffered.value = false;
	}
}

async function loadOperations(): Promise<void> {
	operationsError.value = null;
	try {
		const page = await useApi().get<{
			items: (Operation & { reason: string | null })[];
			nextCursor?: string | null;
		}>(`/sites/${encodeURIComponent(siteId)}/operations`);
		operations.value = page.items;
	} catch (failure) {
		operationsError.value = toApiClientError(failure);
	}
}

onMounted(() => {
	void loadSite().then(loadCutover);
	void loadOperations();
});

useHead({ title: () => site.value?.name ?? 'Site' });

const adminUrl = computed(() => (site.value ? adminUrlFor(site.value) : null));

// the activity list is how the page learns of an earlier adoption; the server refuses a second one
const adopted = computed(
	() =>
		operations.value?.find(
			(operation) => operation.type === 'site.adopt' && operation.status === 'succeeded'
		) ?? null
);
const canAdopt = computed(
	() =>
		site.value?.plane === 'self-managed' &&
		site.value.state === 'active' &&
		operations.value !== null &&
		adopted.value === null
);
const siteMissing = computed(() => siteError.value?.status === 404);

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

function when(value: string): string {
	return dateFormat.format(new Date(value));
}

async function tryAgain(operation: Operation): Promise<void> {
	const org = site.value?.orgId;
	if (!org) return;
	retryError.value = null;
	retryingId.value = operation.id;
	try {
		const next = await useOperationsStore().retry(org, operation.id);
		await router.push(`/new/progress/${encodeURIComponent(next.id)}`);
	} catch (failure) {
		retryError.value = refusalReason(toApiClientError(failure));
	} finally {
		retryingId.value = null;
	}
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

				<div v-if="cutoverOffered">
					<UButton
						color="neutral"
						variant="outline"
						icon="i-lucide-arrow-right-left"
						:to="`/sites/${encodeURIComponent(site.id)}/cutover`"
					>
						Cut Over
					</UButton>
				</div>

				<div v-if="site.plane === 'managed' && site.state === 'active'">
					<UButton
						color="neutral"
						variant="outline"
						icon="i-lucide-globe"
						:to="`/sites/${encodeURIComponent(site.id)}/domain`"
					>
						Custom Domain
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

				<SiteAdopt
					v-if="canAdopt"
					:org-id="site.orgId"
					:site-id="site.id"
					:name="site.name"
				/>
				<p
					v-else-if="adopted"
					class="text-sm text-default"
				>
					This site was adopted.
					<NuxtLink
						:to="`/sites/${encodeURIComponent(adopted.targetIds[0] ?? '')}`"
						class="font-medium text-brand-700 underline dark:text-brand-300"
						>Open the managed copy</NuxtLink
					>
				</p>
			</template>

			<section class="flex flex-col gap-3">
				<h2 class="text-lg font-semibold text-highlighted">Recent Activity</h2>

				<p
					v-if="retryError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ retryError }}
				</p>

				<UiErrorState
					v-if="operationsError"
					title="Could Not Load Activity"
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
					<span class="sr-only">Loading activity</span>
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
					title="No Activity Yet"
					text="Activity for this site appears here."
				/>

				<ul
					v-else
					class="flex flex-col divide-y divide-default rounded-lg border border-default"
				>
					<li
						v-for="operation in operations"
						:key="operation.id"
						class="flex flex-col gap-2 px-4 py-3 text-sm"
					>
						<div class="flex flex-wrap items-center justify-between gap-3">
							<span class="font-medium text-highlighted">{{
								operationTypeLabel(operation.type)
							}}</span>
							<OpBadge :status="operation.status" />
							<time
								:datetime="operation.updatedAt"
								class="text-muted"
								>{{ when(operation.updatedAt) }}</time
							>
						</div>
						<p
							v-if="operation.reason"
							class="text-red-700 dark:text-red-400"
						>
							{{ operation.reason }}
						</p>
						<div v-if="canRetry(operation.type, operation.status)">
							<UButton
								color="neutral"
								size="sm"
								:loading="retryingId === operation.id"
								@click="tryAgain(operation)"
							>
								Try Again
							</UButton>
						</div>
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
