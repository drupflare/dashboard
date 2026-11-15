<script setup lang="ts">
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import type {
	ModuleCheck,
	ModuleKind,
	ModuleListItem,
	ModuleQuery,
	ModuleState
} from '~/shared/modules';
import { useBillingStore } from '~/stores/billing';
import { changeKey, moduleListKey, useModulesStore, type ModuleChange } from '~/stores/modules';
import type { SiteSummary } from '~/stores/sites';

definePageMeta({ middleware: ['auth'] });

const route = useRoute();
const siteId = String(route.params.id);
const modules = useModulesStore();
const billing = useBillingStore();

const site = ref<SiteSummary | null>(null);
const siteError = ref<ApiClientError | null>(null);
const tab = ref<ModuleKind>('module');
const q = ref('');
const state = ref<ModuleState | undefined>(undefined);
const checkingName = ref<string | null>(null);
const strataRows = ref<ModuleListItem[] | null>(null);

const orgId = computed(() => site.value?.orgId ?? null);
// the worker gives no kind, so every row is unknown and only the themes tab filters on kind
const query = computed<ModuleQuery>(() => ({
	q: q.value,
	state: state.value,
	kind: tab.value === 'theme' ? 'theme' : undefined
}));
const key = computed(() => moduleListKey(siteId, query.value));
const items = computed(() => modules.lists.get(key.value));
const loadError = computed(() => modules.errors.get(key.value) ?? null);
const tabs = [
	{ label: 'Modules', value: 'module' },
	{ label: 'Themes', value: 'theme' }
];
const strata = computed(() => strataRows.value?.find((row) => row.name === 'earth-app/strata'));
const entitlement = computed(() => {
	if (orgId.value === null) return undefined;
	return billing.entitlements.get(orgId.value);
});
const strataIncluded = computed<boolean | null>(() => {
	if (entitlement.value === undefined || entitlement.value === null) return null;
	return entitlement.value.features?.strata === true;
});
const shownName = ref<string | null>(null);
const check = computed<ModuleCheck | null>(
	() => modules.checks.get(`${siteId}|${shownName.value ?? ''}`) ?? null
);
const shownRow = computed(
	() =>
		items.value?.find((row) => row.name === shownName.value) ??
		strataRows.value?.find((row) => row.name === shownName.value)
);
const changeOf = (change: ModuleChange) =>
	computed(() => modules.changes.get(changeKey(siteId, shownName.value ?? '', change)) ?? null);
const installOp = changeOf('install');
const enableOp = changeOf('enable');
const starting = ref<'install' | 'enable' | null>(null);
const changeError = ref<string | null>(null);
const removeNotice = ref<string | null>(null);

async function load(): Promise<void> {
	if (orgId.value === null) return;
	try {
		await modules.search(orgId.value, siteId, query.value);
	} catch {
		// the failure is kept in the store for the screen to show
	}
}

async function loadSite(): Promise<void> {
	siteError.value = null;
	try {
		site.value = await useApi().get<SiteSummary>(`/sites/${encodeURIComponent(siteId)}`);
		if (orgId.value === null) return;
		await billing.loadEntitlement(orgId.value);
		strataRows.value = (await modules.search(orgId.value, siteId, { q: 'strata' })) ?? [];
		await load();
	} catch (failure) {
		siteError.value = toApiClientError(failure);
	}
}

async function runCheck(name: string): Promise<void> {
	if (orgId.value === null) return;
	checkingName.value = name;
	shownName.value = name;
	try {
		await modules.check(orgId.value, siteId, name);
	} catch (cause) {
		const failure = toApiClientError(cause);
		modules.checks.set(`${siteId}|${name}`, {
			ok: false,
			conflicts: [],
			message: failure.message
		});
	} finally {
		checkingName.value = null;
	}
}

// the install and the enable run as operations; the page reads them until they end
async function runChange(change: 'install' | 'enable', name: string, confirm = false) {
	if (orgId.value === null) return;
	shownName.value = name;
	changeError.value = null;
	starting.value = change;
	try {
		const operation = await modules.change(orgId.value, siteId, change, {
			name,
			...(change === 'install' ? { confirm } : {})
		});
		starting.value = null;
		await modules.follow(orgId.value, siteId, change, operation, name);
	} catch (cause) {
		changeError.value = toApiClientError(cause).message;
	} finally {
		starting.value = null;
	}
}

// the refusal of a removal is the site's own reason, shown as it is
async function runRemove(name: string) {
	if (orgId.value === null) return;
	removeNotice.value = null;
	try {
		const operation = await modules.change(orgId.value, siteId, 'remove', { name });
		await navigateTo(`/new/progress/${operation.id}`);
	} catch (cause) {
		removeNotice.value = toApiClientError(cause).message;
	}
}

watch([q, state, tab], () => void load());
onMounted(() => void loadSite());

useHead({ title: () => (site.value ? `Modules for ${site.value.name}` : 'Modules') });
</script>

<template>
	<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
		<header>
			<h1 class="text-2xl font-semibold">Modules</h1>
			<p class="text-sm text-muted">
				Search the modules and themes this site can take. Check one to see whether it fits
				the code the site already has, then install it and turn it on. A restore point is
				saved before each change.
			</p>
		</header>

		<p
			v-if="siteError"
			class="text-sm text-error"
		>
			This site could not be loaded.
		</p>

		<UTabs
			v-model="tab"
			:items="tabs"
			:content="false"
		/>

		<SiteModuleSearch
			v-model:q="q"
			v-model:state="state"
		/>

		<section
			v-if="tab === 'module' && strata"
			aria-label="Optional Add-On"
		>
			<SiteModuleStrata
				:included="strataIncluded"
				:unlock-plan="null"
				:state="strata.state"
			/>
		</section>

		<p
			v-if="loadError"
			class="text-sm text-error"
		>
			The module list could not be loaded. Try again in a moment.
		</p>
		<p
			v-else-if="items === undefined"
			class="text-sm text-muted"
		>
			Loading modules.
		</p>
		<p
			v-else-if="items !== null && items.length === 0"
			class="text-sm text-muted"
		>
			{{ tab === 'theme' ? 'No themes are listed yet.' : 'No modules match this search.' }}
		</p>
		<ul
			v-else-if="items"
			class="rounded-lg border border-default"
		>
			<SiteModuleRow
				v-for="row in items"
				:key="row.name"
				:row="row"
				:checking="checkingName === row.name"
				@check="(row) => runCheck(row.name)"
				@enable="(row) => runChange('enable', row.name)"
				@remove="(row) => runRemove(row.name)"
			/>
		</ul>

		<p
			v-if="removeNotice"
			role="alert"
			class="text-sm text-error"
		>
			{{ removeNotice }}
		</p>

		<SiteModuleInstall
			v-if="shownName && shownRow"
			:name="shownName"
			:state="shownRow.state"
			:shipping="shownRow.shipping"
			:check="check"
			:checking="checkingName !== null"
			:install="installOp"
			:enable="enableOp"
			:starting="starting"
			:error="changeError"
			@run="runCheck(shownName)"
			@install="(confirm) => runChange('install', shownName!, confirm)"
			@enable="runChange('enable', shownName!)"
		/>
	</div>
</template>
