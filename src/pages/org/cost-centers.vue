<script setup lang="ts">
import CostTree from '~/components/cost/Tree.vue';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { useCostCentersStore } from '~/stores/cost-centers';
import { useOrgStore } from '~/stores/org';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Cost Centers' });

const org = useOrgStore();
const costs = useCostCentersStore();

const orgId = computed(() => org.current?.id ?? null);
const role = computed(() => org.current?.role);
const canRead = computed(
	() => isOrgRole(role.value) && ORG_ROLE_ACTIONS[role.value].includes('cost-center.read')
);
const canManage = computed(
	() => isOrgRole(role.value) && ORG_ROLE_ACTIONS[role.value].includes('cost-center.manage')
);

const thisMonth = new Date().toISOString().slice(0, 7);
const month = ref(thisMonth);
const amountDollars = ref('');

const centers = computed(() => (orgId.value ? costs.centers.get(orgId.value) : undefined));
const sites = computed(() => (orgId.value ? costs.sites.get(orgId.value) : undefined));

const amountCents = computed(() => {
	const value = Number(amountDollars.value);
	return amountDollars.value === '' || !Number.isFinite(value) ? null : Math.round(value * 100);
});

const report = computed(() =>
	orgId.value ? costs.reportOf(orgId.value, month.value, amountCents.value) : undefined
);

const exportHref = computed(() => {
	if (!orgId.value) return '#';
	const query = new URLSearchParams({ month: month.value });
	if (amountCents.value !== null) query.set('amountCents', String(amountCents.value));
	return `/api/v1/orgs/${encodeURIComponent(orgId.value)}/cost-centers/export?${query}`;
});

const stateLabel: Record<string, string> = {
	exact: 'Exact',
	estimated: 'Estimated',
	unaccounted: 'Unaccounted'
};

const form = reactive({ code: '', name: '', ownerContact: '' });

async function load(id: string) {
	if (!canRead.value) return;
	await Promise.all([costs.loadCenters(id), costs.loadSites(id)]);
	await costs.loadReport(id, month.value, amountCents.value);
}

onMounted(() => {
	if (orgId.value) void load(orgId.value);
});

watch(orgId, (id) => {
	if (id) void load(id);
});

watch([month, amountCents], () => {
	if (orgId.value && canRead.value)
		void costs.loadReport(orgId.value, month.value, amountCents.value);
});

const state = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (org.current && !canRead.value) return 'no-access';
	if (costs.error && centers.value === undefined) return 'error';
	if (centers.value === undefined) return 'loading';
	if (centers.value.length === 0) return 'empty';
	return 'ready';
});

async function createCenter() {
	if (!orgId.value) return;
	const ok = await costs.save(orgId.value, null, {
		code: form.code,
		name: form.name,
		ownerContact: form.ownerContact || null
	});
	if (ok) Object.assign(form, { code: '', name: '', ownerContact: '' });
}

async function assign(siteId: string, costCenterId: string | null) {
	if (!orgId.value) return;
	await costs.assign(orgId.value, siteId, { costCenterId });
	await costs.loadReport(orgId.value, month.value, amountCents.value);
}

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:outline-2 focus-visible:outline-primary';
</script>

<template>
	<div class="mx-auto max-w-5xl space-y-8 px-4 py-8">
		<header class="space-y-1">
			<h1 class="text-2xl font-semibold text-default">Cost Centers</h1>
			<p class="text-muted">
				A cost center groups the sites that one budget pays for. It never grants access.
			</p>
		</header>

		<ClientOnly>
			<p
				v-if="state === 'loading'"
				class="text-muted"
				role="status"
			>
				Loading cost centers.
			</p>
			<p
				v-else-if="state === 'org-error' || state === 'error'"
				class="text-danger"
				role="alert"
			>
				The cost centers could not be loaded. Try again in a moment.
			</p>
			<p
				v-else-if="state === 'no-org'"
				class="text-muted"
			>
				Choose an organisation to see its cost centers.
			</p>
			<p
				v-else-if="state === 'no-access'"
				class="text-muted"
			>
				Your role cannot view cost centers.
			</p>

			<template v-else-if="state === 'empty' || state === 'ready'">
				<section
					v-if="canManage"
					class="space-y-3"
				>
					<h2 class="font-semibold text-default">Add a Cost Center</h2>
					<form
						class="grid gap-3 sm:grid-cols-3"
						@submit.prevent="createCenter"
					>
						<label class="space-y-1">
							<span class="text-sm text-muted">Code</span>
							<input
								v-model="form.code"
								:class="inputClass"
								required
								maxlength="32"
							/>
						</label>
						<label class="space-y-1">
							<span class="text-sm text-muted">Name</span>
							<input
								v-model="form.name"
								:class="inputClass"
								required
								maxlength="120"
							/>
						</label>
						<label class="space-y-1">
							<span class="text-sm text-muted">Owner Contact</span>
							<input
								v-model="form.ownerContact"
								:class="inputClass"
								maxlength="200"
							/>
						</label>
						<button
							type="submit"
							class="justify-self-start rounded-md border border-default px-3 py-2 text-default"
							:disabled="costs.saving"
						>
							Add Cost Center
						</button>
					</form>
					<p
						v-if="costs.saveError"
						class="text-danger"
						role="alert"
					>
						{{ costs.saveError.message }}
					</p>
				</section>

				<p
					v-if="state === 'empty'"
					class="text-muted"
				>
					No cost centers yet. Add one to start grouping sites.
				</p>

				<template v-else>
					<section class="space-y-3">
						<h2 class="font-semibold text-default">Sites by Cost Center</h2>
						<CostTree
							v-if="sites !== undefined"
							:centers="centers ?? []"
							:sites="sites"
							:saving="costs.saving"
							@assign="assign"
						/>
					</section>

					<section class="space-y-3">
						<h2 class="font-semibold text-default">Monthly Usage</h2>
						<div class="flex flex-wrap items-end gap-3">
							<label class="space-y-1">
								<span class="text-sm text-muted">Month</span>
								<input
									v-model="month"
									type="month"
									:class="inputClass"
								/>
							</label>
							<label class="space-y-1">
								<span class="text-sm text-muted"
									>Organisation Total, in Dollars</span
								>
								<input
									v-model="amountDollars"
									type="number"
									min="0"
									step="0.01"
									:class="inputClass"
								/>
							</label>
							<a
								class="rounded-md border border-default px-3 py-2 text-default"
								:href="exportHref"
							>
								Download CSV
							</a>
						</div>

						<p
							v-if="report === null"
							class="text-danger"
							role="alert"
						>
							The report could not be read.
						</p>
						<p
							v-else-if="report === undefined"
							class="text-muted"
							role="status"
						>
							Loading the report.
						</p>
						<template v-else>
							<p class="text-sm text-muted">
								Usage counts only where the hours were accounted for. Unaccounted
								hours show no views. The projection draws a straight line through
								the views so far. It is not a forecast.
							</p>
							<div
								class="overflow-x-auto"
								tabindex="0"
								role="region"
								aria-label="Cost Center Usage"
							>
								<table class="w-full text-left text-sm">
									<thead>
										<tr class="border-b border-default">
											<th class="py-2 pr-3">Cost Center</th>
											<th class="py-2 pr-3">Sites</th>
											<th class="py-2 pr-3">Views</th>
											<th class="py-2 pr-3">Accounting</th>
											<th class="py-2 pr-3">Allocated</th>
											<th class="py-2 pr-3">Share</th>
											<th class="py-2 pr-3">Straight-Line Projection</th>
										</tr>
									</thead>
									<tbody>
										<tr
											v-for="row in report.rows"
											:key="row.costCenterId"
											class="border-b border-default"
										>
											<td class="py-2 pr-3 text-default">
												{{ row.code }} {{ row.name }}
											</td>
											<td class="py-2 pr-3">{{ row.siteCount }}</td>
											<td class="py-2 pr-3">
												{{ row.views.toLocaleString('en-US') }}
											</td>
											<td class="py-2 pr-3">{{ stateLabel[row.state] }}</td>
											<td class="py-2 pr-3">
												{{
													row.allocatedCents === null
														? 'Enter a Total'
														: `$${(row.allocatedCents / 100).toFixed(2)}`
												}}
											</td>
											<td class="py-2 pr-3">
												{{
													row.share === null
														? 'None Yet'
														: `${(row.share * 100).toFixed(1)}%`
												}}
											</td>
											<td class="py-2 pr-3">
												{{
													row.projectedViews === null
														? 'Not Enough Data'
														: row.projectedViews.toLocaleString('en-US')
												}}
											</td>
										</tr>
									</tbody>
								</table>
							</div>
							<section class="space-y-1">
								<h2 class="font-semibold text-default">Central IT Summary</h2>
								<p class="text-default">
									{{ report.central.costCenters }} cost centers,
									{{ report.central.sites }} sites,
									{{ report.central.unassignedSites }} without a cost center.
									{{ report.central.views.toLocaleString('en-US') }} views,
									{{ stateLabel[report.central.state] }}.
								</p>
							</section>
						</template>
					</section>
				</template>
			</template>
			<template #fallback>
				<p
					class="text-muted"
					role="status"
				>
					Loading cost centers.
				</p>
			</template>
		</ClientOnly>
	</div>
</template>
