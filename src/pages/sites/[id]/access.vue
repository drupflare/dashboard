<script setup lang="ts">
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import { environmentStatus } from '~/shared/access-copy';
import { useAccessStore, type AddRuleResult, type EnvironmentView } from '~/stores/access';
import type { SiteSummary } from '~/stores/sites';

definePageMeta({ middleware: ['auth'] });

const route = useRoute();
const siteId = String(route.params.id);
const access = useAccessStore();

const site = ref<SiteSummary | null>(null);
const siteError = ref<ApiClientError | null>(null);
const environmentsError = ref(false);
const notActive = ref(false);
const removeError = ref<string | null>(null);
const removing = ref(false);

const orgId = computed(() => site.value?.orgId ?? null);
const view = computed(() => access.views.get(siteId));
const loadError = computed(() => access.errors.get(siteId) ?? null);
const environments = computed<EnvironmentView[]>(() => access.environments.get(siteId) ?? []);
const presets = computed(() => view.value?.presets ?? []);
const inviteeLimit = computed(() => view.value?.inviteeLimit ?? null);

// rules whose environment is no longer listed still get a section, so they can be removed
const sections = computed(() => {
	const rules = view.value?.rules ?? [];
	const known = new Set(environments.value.map((item) => item.id));
	const list = [
		{ id: 'prod', name: 'Production', production: true },
		...environments.value.map((item) => ({ id: item.id, name: item.name, production: false }))
	];
	const orphaned = rules.filter(
		(rule) => rule.environment !== 'prod' && !known.has(rule.environment)
	);
	if (orphaned.length > 0) {
		list.push({ id: '__removed', name: 'Removed Environment', production: false });
	}
	return list.map((section) => ({
		...section,
		rules:
			section.id === '__removed'
				? orphaned
				: rules.filter((rule) => rule.environment === section.id),
		status: environmentStatus(
			section.production,
			section.id === '__removed'
				? orphaned
				: rules.filter((rule) => rule.environment === section.id)
		)
	}));
});

async function load(): Promise<void> {
	if (orgId.value === null) return;
	try {
		await access.read(orgId.value, siteId);
	} catch {
		// the failure is kept in the store for the screen to show
	}
	try {
		await access.loadEnvironments(orgId.value, siteId);
		environmentsError.value = false;
	} catch {
		environmentsError.value = true;
	}
}

async function loadSite(): Promise<void> {
	siteError.value = null;
	try {
		site.value = await useApi().get<SiteSummary>(`/sites/${encodeURIComponent(siteId)}`);
		await load();
	} catch (failure) {
		siteError.value = toApiClientError(failure);
	}
}

function onAdded(result: AddRuleResult): void {
	notActive.value = !result.active;
}

async function onRemove(ruleId: string): Promise<void> {
	if (orgId.value === null) return;
	removeError.value = null;
	removing.value = true;
	try {
		const result = await access.removeRule(orgId.value, siteId, ruleId);
		notActive.value = !result.active;
	} catch (cause) {
		removeError.value = toApiClientError(cause).message;
	} finally {
		removing.value = false;
	}
}

onMounted(() => void loadSite());

useHead({ title: () => (site.value ? `Access for ${site.value.name}` : 'Access') });
</script>

<template>
	<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
		<header>
			<h1 class="text-2xl font-semibold">Access</h1>
			<p class="text-sm text-muted">
				Choose who can open each environment of this site. Rules combine, so a visitor who
				matches any rule gets in.
			</p>
		</header>

		<p
			v-if="siteError"
			class="text-sm text-error"
		>
			This site could not be loaded.
		</p>

		<section
			v-if="notActive || view?.activeOnSite === false"
			role="status"
			class="flex items-start gap-2 rounded-lg border border-warning p-4"
		>
			<UIcon
				name="i-lucide-clock"
				class="mt-0.5 size-4 shrink-0 text-warning"
				aria-hidden="true"
			/>
			<div class="flex flex-col gap-1">
				<p class="font-medium text-warning">Saved. Not Active on the Site Yet.</p>
				<p class="text-sm text-muted">
					The site has not picked up this change, so visitors still get the access it had
					before.
				</p>
			</div>
		</section>

		<p
			v-if="loadError"
			class="text-sm text-error"
		>
			The access rules could not be loaded. Try again in a moment.
		</p>
		<p
			v-else-if="view === undefined"
			class="text-sm text-muted"
		>
			Loading access rules.
		</p>
		<p
			v-else-if="view === null"
			class="text-sm text-muted"
		>
			This site could not be found.
		</p>
		<template v-else>
			<p
				v-if="environmentsError"
				class="text-sm text-error"
			>
				The environments could not be loaded. Production is shown below.
			</p>

			<section
				v-for="section in sections"
				:key="section.id"
				class="flex flex-col gap-3"
				:aria-label="section.name"
			>
				<div class="flex flex-col gap-1">
					<h2 class="text-lg font-semibold">{{ section.name }}</h2>
					<p
						class="inline-flex items-center gap-1.5 text-sm"
						:class="section.status.tone"
					>
						<UIcon
							:name="section.status.icon"
							class="size-4"
							aria-hidden="true"
						/>
						{{ section.status.sentence }}
					</p>
				</div>
				<SiteAccessRules
					:rules="section.rules"
					:presets="presets"
					:busy="removing"
					@remove="onRemove"
				/>
			</section>

			<p
				v-if="removeError"
				role="alert"
				class="text-sm text-error"
			>
				{{ removeError }}
			</p>

			<section
				class="flex flex-col gap-3"
				aria-label="Add a Rule"
			>
				<h2 class="text-lg font-semibold">Add a Rule</h2>
				<SiteAccessInvite
					:org-id="orgId ?? ''"
					:site-id="siteId"
					:presets="presets"
					:environments="environments"
					:invitee-limit="inviteeLimit"
					@added="onAdded"
				/>
			</section>

			<section
				class="flex flex-col gap-3"
				aria-label="Access Types"
			>
				<h2 class="text-lg font-semibold">Access Types</h2>
				<SiteAccessPresets :presets="presets" />
			</section>
		</template>
	</div>
</template>
