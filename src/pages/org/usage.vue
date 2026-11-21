<script setup lang="ts">
import ChartTable from '~/components/chart/Table.vue';
import ChartUsage from '~/components/chart/Usage.vue';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import { OVERSHOOT_BOUND_SENTENCE } from '~/shared/budget-rules';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import type { DayView, OrgUsage, SiteMonthUsage, UsageBar } from '~/shared/usage';
import { useOrgStore } from '~/stores/org';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Usage' });

const org = useOrgStore();

const orgId = computed(() => org.current?.id ?? null);
const role = computed(() => org.current?.role);
const canRead = computed(
	() => isOrgRole(role.value) && ORG_ROLE_ACTIONS[role.value].includes('usage.read')
);

const month = ref(new Date().toISOString().slice(0, 7));
const siteId = ref('all');
const usage = ref<OrgUsage | null>(null);
const siteUsage = ref<SiteMonthUsage | null>(null);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);

async function load() {
	if (!orgId.value || !canRead.value) return;
	loading.value = true;
	error.value = null;
	try {
		const base = `/orgs/${encodeURIComponent(orgId.value)}`;
		usage.value = await useApi().get<OrgUsage>(`${base}/usage`, { month: month.value });
		siteUsage.value =
			siteId.value === 'all'
				? null
				: await useApi().get<SiteMonthUsage>(
						`${base}/sites/${encodeURIComponent(siteId.value)}/usage`,
						{ month: month.value }
					);
	} catch (cause) {
		error.value = toApiClientError(cause);
	} finally {
		loading.value = false;
	}
}

watch([orgId, month, siteId], () => void load(), { immediate: true });

const state = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (org.current && !canRead.value) return 'no-access';
	if (error.value) return 'error';
	if (usage.value === null) return 'loading';
	return 'ready';
});

const monthLabel = computed(() =>
	new Date(`${month.value}-01T00:00:00Z`).toLocaleDateString('en-US', {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	})
);

const allowanceText = computed(() => {
	const allowance = usage.value?.allowance;
	if (!allowance) return '';
	if (allowance.views === null) return 'Your plan lists no view allowance.';
	const views = allowance.views.toLocaleString('en-US');
	return allowance.pooled
		? `Your plan allows ${views} views a month, shared across your sites.`
		: `Your plan allows ${views} views a month for each site.`;
});

const sitesOrdered = computed(() =>
	[...(usage.value?.sites ?? [])].sort(
		(a, b) => b.views - a.views || a.name.localeCompare(b.name)
	)
);

const siteBars = computed<UsageBar[]>(() =>
	sitesOrdered.value.map((site) => ({ label: site.name, value: site.views, state: site.state }))
);

// the org totals sit under total, while the days stay at the top level
const shown = computed(() =>
	siteId.value === 'all' ? (usage.value?.total ?? null) : siteUsage.value
);

const shownDays = computed<DayView[]>(() =>
	siteId.value === 'all' ? (usage.value?.days ?? []) : (siteUsage.value?.days ?? [])
);

const dayBars = computed<UsageBar[]>(() =>
	shownDays.value.map((day) => ({
		label: day.day,
		value: day.views,
		state: day.state
	}))
);

const dayRows = computed(() =>
	shownDays.value.map((day) => ({
		label: day.day,
		views: day.views,
		lowerBound: day.lowerBound,
		state: day.state
	}))
);

const siteRows = computed(() =>
	sitesOrdered.value.map((site) => ({
		label: site.name,
		views: site.views,
		lowerBound: site.lowerBound,
		state: site.state
	}))
);

const inputClass =
	'rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:outline-2 focus-visible:outline-primary';
</script>

<template>
	<div class="mx-auto max-w-5xl space-y-8 px-4 py-8">
		<header class="space-y-1">
			<h1 class="text-2xl font-semibold text-default">Usage</h1>
			<p class="text-muted">
				Views served by your sites, per day, with how sure the count is.
			</p>
		</header>

		<ClientOnly>
			<p
				v-if="state === 'loading'"
				class="text-muted"
				role="status"
			>
				Loading usage.
			</p>
			<p
				v-else-if="state === 'org-error' || state === 'error'"
				class="text-danger"
				role="alert"
			>
				Usage could not be loaded. Try again in a moment.
			</p>
			<p
				v-else-if="state === 'no-org'"
				class="text-muted"
			>
				Choose an organisation to see its usage.
			</p>
			<p
				v-else-if="state === 'no-access'"
				class="text-muted"
			>
				Your role cannot view usage.
			</p>

			<template v-else-if="state === 'ready' && usage">
				<div class="flex flex-wrap items-end gap-4">
					<label class="flex flex-col gap-1 text-sm">
						<span class="font-medium text-default">Month</span>
						<input
							v-model="month"
							type="month"
							:class="inputClass"
						/>
					</label>
					<label class="flex flex-col gap-1 text-sm">
						<span class="font-medium text-default">Site</span>
						<select
							v-model="siteId"
							:class="inputClass"
						>
							<option value="all">All Sites</option>
							<option
								v-for="site in usage.sites"
								:key="site.siteId"
								:value="site.siteId"
							>
								{{ site.name }}
							</option>
						</select>
					</label>
				</div>

				<section class="space-y-3">
					<h2 class="text-lg font-medium text-highlighted">{{ monthLabel }}</h2>
					<p class="text-default">
						{{ shown?.views.toLocaleString('en-US') }} views. The lower bound is
						{{ shown?.lowerBound.toLocaleString('en-US') }}.
					</p>
					<p
						v-if="allowanceText"
						class="text-muted"
					>
						{{ allowanceText }}
					</p>
					<p class="text-muted">Views are counted when the response completes.</p>
					<p class="text-muted">
						When a budget stops a site: {{ OVERSHOOT_BOUND_SENTENCE }}
					</p>
					<ChartUsage
						v-if="dayBars.length > 0"
						:bars="dayBars"
						:ariaLabel="`Views per day in ${monthLabel}`"
					/>
					<ChartTable
						v-if="dayRows.length > 0"
						caption="Views per day"
						:rows="dayRows"
					/>
				</section>

				<section
					v-if="siteId === 'all' && siteRows.length > 0"
					class="space-y-3"
				>
					<h2 class="text-lg font-medium text-highlighted">Sites</h2>
					<ChartUsage
						:bars="siteBars"
						ariaLabel="Views per site, largest first"
						show-values
					/>
					<ChartTable
						caption="Views per site"
						:rows="siteRows"
					/>
				</section>
				<p
					v-else-if="siteId === 'all'"
					class="text-muted"
				>
					No managed sites in this organisation yet.
				</p>
			</template>
			<template #fallback>
				<p
					class="text-muted"
					role="status"
				>
					Loading usage.
				</p>
			</template>
		</ClientOnly>
	</div>
</template>
