<script setup lang="ts">
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import { useSiteConfigStore, type SettingsView } from '~/stores/site-config';
import type { SiteSummary } from '~/stores/sites';

definePageMeta({ middleware: ['auth'] });

const route = useRoute();
const siteId = String(route.params.id);
const store = useSiteConfigStore();

const site = ref<SiteSummary | null>(null);
const siteError = ref<ApiClientError | null>(null);
const siteMissing = ref(false);

const orgId = computed(() => site.value?.orgId ?? null);
const view = computed<SettingsView | null | undefined>(() => store.bySite.get(siteId));
const loadError = computed(() => store.errors.get(siteId) ?? null);
const loading = computed(
	() => view.value === undefined && loadError.value === null && !siteError.value
);

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const observed = computed(() =>
	view.value?.observedAt ? dateFormat.format(new Date(view.value.observedAt)) : null
);

async function load(): Promise<void> {
	if (orgId.value === null) return;
	try {
		await store.read(orgId.value, siteId);
	} catch {
		// the failure is kept in the store for the screen to show
	}
}

async function refresh(): Promise<void> {
	if (orgId.value === null) return;
	try {
		await store.read(orgId.value, siteId, true);
	} catch {
		// the failure is kept in the store for the screen to show
	}
}

async function loadSite(): Promise<void> {
	siteError.value = null;
	try {
		site.value = await useApi().get<SiteSummary>(`/sites/${encodeURIComponent(siteId)}`);
		await load();
	} catch (failure) {
		const error = toApiClientError(failure);
		if (error.status === 404) siteMissing.value = true;
		else siteError.value = error;
	}
}

onMounted(() => {
	void loadSite();
});

// the Wrangler and Effective views read the same groups as the form, so they share one list
const groups = computed(() => view.value?.groups ?? []);
</script>

<template>
	<ClientOnly>
		<div class="flex max-w-4xl flex-col gap-6">
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
				v-else-if="siteError || loadError"
				title="Could Not Load the Settings"
				:text="(siteError ?? loadError)?.message ?? ''"
				:request-id="(siteError ?? loadError)?.requestId"
			>
				<UButton
					color="neutral"
					@click="loadSite()"
				>
					Try Again
				</UButton>
			</UiErrorState>

			<div
				v-else-if="loading"
				class="flex items-center gap-2 text-sm text-muted"
			>
				<UIcon
					name="i-lucide-loader-circle"
					class="size-4 animate-spin"
				/>
				Loading Settings
			</div>

			<UiEmptyState
				v-else-if="view === null"
				icon="i-lucide-settings"
				title="Settings Not Available"
				text="This site is not ready yet, so its settings cannot be read."
			/>

			<template v-else-if="view">
				<header class="flex flex-col gap-1">
					<h1 class="text-xl font-semibold">Settings</h1>
					<p
						v-if="view.state === 'ready' && view.stale"
						class="text-sm text-muted"
					>
						The site did not answer just now. Showing the settings it reported{{
							observed ? ` on ${observed}` : ''
						}}.
					</p>
					<p
						v-if="view.state === 'fallback'"
						class="text-sm text-muted"
					>
						This site does not report its settings, so each setting is described without
						a current value.
					</p>
				</header>

				<UiEmptyState
					v-if="view.state === 'empty'"
					icon="i-lucide-settings"
					title="No Settings Yet"
					:text="view.reason ?? ''"
				/>

				<template v-else>
					<SiteConfigForm
						:groups="groups"
						:org-id="orgId ?? undefined"
						:site-id="siteId"
						:etag="view.etag"
						@refresh="refresh()"
					/>

					<section
						v-if="view.state === 'ready' && orgId"
						class="flex flex-col gap-3"
						aria-labelledby="history-heading"
					>
						<h2
							id="history-heading"
							class="text-base font-semibold"
						>
							Change History
						</h2>
						<SiteConfigHistory
							:org-id="orgId"
							:site-id="siteId"
						/>
					</section>

					<section
						v-if="groups.length"
						class="flex flex-col gap-3"
						aria-labelledby="effective-heading"
					>
						<h2
							id="effective-heading"
							class="text-base font-semibold"
						>
							Effective Configuration
						</h2>
						<SiteConfigEffective :groups="groups" />
					</section>

					<section
						v-if="groups.length"
						class="flex flex-col gap-3"
						aria-labelledby="wrangler-heading"
					>
						<h2
							id="wrangler-heading"
							class="text-base font-semibold"
						>
							Wrangler Configuration
						</h2>
						<p class="text-sm text-muted">
							A read-only view of the deploy settings in this site's configuration
							file.
						</p>
						<SiteConfigWrangler :groups="groups" />
					</section>

					<section
						v-if="view.redirects.length"
						class="flex flex-col gap-3"
						aria-labelledby="redirects-heading"
					>
						<h2
							id="redirects-heading"
							class="text-base font-semibold"
						>
							Redirects
						</h2>
						<table class="w-full text-left text-sm">
							<thead>
								<tr class="border-b border-default text-muted">
									<th
										scope="col"
										class="py-1.5 pr-4 font-medium"
									>
										From
									</th>
									<th
										scope="col"
										class="py-1.5 font-medium"
									>
										To
									</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="redirect in view.redirects"
									:key="redirect.from"
									class="border-b border-default last:border-0"
								>
									<td class="py-1.5 pr-4 font-mono text-xs">
										{{ redirect.from }}
									</td>
									<td class="py-1.5 font-mono text-xs">{{ redirect.to }}</td>
								</tr>
							</tbody>
						</table>
					</section>
				</template>
			</template>
		</div>
	</ClientOnly>
</template>
