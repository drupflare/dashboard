<script setup lang="ts">
import PilotWorkspace from '~/components/pilot/Workspace.vue';
import PilotReportSummary from '~/components/pilot/report/Summary.vue';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { useCostCentersStore } from '~/stores/cost-centers';
import { useOrgStore } from '~/stores/org';
import { usePilotsStore } from '~/stores/pilots';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Pilot' });

const route = useRoute();
const org = useOrgStore();
const pilots = usePilotsStore();
const costs = useCostCentersStore();

const pilotId = computed(() => String(route.params.id));
const orgId = computed(() => org.current?.id ?? null);
const role = computed(() => org.current?.role);
const canRead = computed(
	() => isOrgRole(role.value) && ORG_ROLE_ACTIONS[role.value].includes('pilot.read')
);
const canManage = computed(
	() => isOrgRole(role.value) && ORG_ROLE_ACTIONS[role.value].includes('pilot.manage')
);

const view = computed(() => pilots.views.get(pilotId.value));
const report = computed(() => pilots.reports.get(pilotId.value));
const sites = computed(() => (orgId.value ? (costs.sites.get(orgId.value) ?? []) : []));
const exportHref = computed(
	() =>
		`/api/v1/orgs/${encodeURIComponent(orgId.value ?? '')}/pilots/${encodeURIComponent(pilotId.value)}/export`
);

async function load(organisation: string) {
	if (!canRead.value) return;
	await Promise.all([
		pilots.loadOne(organisation, pilotId.value),
		pilots.loadReport(organisation, pilotId.value)
	]);
	if (canManage.value) await costs.loadSites(organisation);
}

onMounted(() => {
	if (orgId.value) void load(orgId.value);
});

watch(orgId, (id) => {
	if (id) void load(id);
});

const state = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (org.current && !canRead.value) return 'no-access';
	if (pilots.error && view.value === undefined) return 'error';
	if (view.value === undefined) return 'loading';
	if (view.value === null) return 'not-found';
	return 'ready';
});
</script>

<template>
	<div class="mx-auto max-w-4xl space-y-8 px-4 py-8">
		<p
			v-if="state === 'loading'"
			class="text-muted"
			role="status"
		>
			Loading the pilot.
		</p>
		<p
			v-else-if="state === 'org-error' || state === 'error'"
			class="text-danger"
			role="alert"
		>
			The pilot could not be loaded. Try again in a moment.
		</p>
		<p
			v-else-if="state === 'no-org'"
			class="text-muted"
		>
			Choose an organisation to see this pilot.
		</p>
		<p
			v-else-if="state === 'no-access'"
			class="text-muted"
		>
			Your role cannot view pilots.
		</p>
		<p
			v-else-if="state === 'not-found'"
			class="text-muted"
		>
			This pilot does not exist.
		</p>

		<template v-else-if="view">
			<header class="space-y-1">
				<NuxtLink
					to="/org/pilots"
					class="text-sm text-muted"
					>All Pilots</NuxtLink
				>
				<h1 class="text-2xl font-semibold text-default">{{ view.name }}</h1>
				<p class="text-muted">{{ view.state }}, started {{ view.startDate }}</p>
			</header>

			<PilotWorkspace
				v-if="orgId"
				:org-id="orgId"
				:pilot="view"
				:sites="sites"
				:can-manage="canManage"
			/>

			<section class="space-y-4 border-t border-default pt-8">
				<h2 class="text-xl font-semibold text-default">Report</h2>
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
				<PilotReportSummary
					v-else
					:report="report"
					:export-href="exportHref"
				/>
			</section>
		</template>
	</div>
</template>
