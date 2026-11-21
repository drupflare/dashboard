<script setup lang="ts">
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { useOrgStore } from '~/stores/org';
import { usePilotsStore } from '~/stores/pilots';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Pilots' });

const org = useOrgStore();
const pilots = usePilotsStore();

const orgId = computed(() => org.current?.id ?? null);
const role = computed(() => org.current?.role);
const canRead = computed(
	() => isOrgRole(role.value) && ORG_ROLE_ACTIONS[role.value].includes('pilot.read')
);
const canManage = computed(
	() => isOrgRole(role.value) && ORG_ROLE_ACTIONS[role.value].includes('pilot.manage')
);

const list = computed(() => (orgId.value ? pilots.lists.get(orgId.value) : undefined));

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:outline-2 focus-visible:outline-primary';

const form = reactive({
	name: '',
	startDate: new Date().toISOString().slice(0, 10),
	sponsor: '',
	technicalOwner: '',
	hostingDollars: '',
	staffHours: '',
	latencyMs: '',
	restoreMinutes: '',
	rollbackMinutes: '',
	patchDays: '',
	successCriteria: ''
});

const optional = (value: string) => (value === '' ? null : Number(value));

async function create() {
	if (!orgId.value) return;
	const dollars = optional(form.hostingDollars);
	const view = await pilots.create(orgId.value, {
		name: form.name,
		startDate: form.startDate,
		sponsor: form.sponsor || null,
		technicalOwner: form.technicalOwner || null,
		baselineHostingSpendCents: dollars === null ? null : Math.round(dollars * 100),
		baselineStaffHours: optional(form.staffHours),
		baselineLatencyMs: optional(form.latencyMs),
		baselineRestoreMinutes: optional(form.restoreMinutes),
		baselineRollbackMinutes: optional(form.rollbackMinutes),
		baselinePatchDays: optional(form.patchDays),
		successCriteria: form.successCriteria
	});
	if (view) await navigateTo(`/org/pilots/${view.id}`);
}

onMounted(() => {
	if (orgId.value && canRead.value) void pilots.loadList(orgId.value);
});

watch(orgId, (id) => {
	if (id && canRead.value) void pilots.loadList(id);
});

const state = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (org.current && !canRead.value) return 'no-access';
	if (pilots.error && list.value === undefined) return 'error';
	if (list.value === undefined) return 'loading';
	if (list.value.length === 0) return 'empty';
	return 'ready';
});
</script>

<template>
	<div class="mx-auto max-w-4xl space-y-8 px-4 py-8">
		<header class="space-y-1">
			<h1 class="text-2xl font-semibold text-default">Pilots</h1>
			<p class="text-muted">
				A pilot compares a set of sites with the hosting it replaces, using the baseline you
				record before it starts.
			</p>
		</header>

		<ClientOnly>
			<p
				v-if="state === 'loading'"
				class="text-muted"
				role="status"
			>
				Loading pilots.
			</p>
			<p
				v-else-if="state === 'org-error' || state === 'error'"
				class="text-danger"
				role="alert"
			>
				The pilots could not be loaded. Try again in a moment.
			</p>
			<p
				v-else-if="state === 'no-org'"
				class="text-muted"
			>
				Choose an organisation to see its pilots.
			</p>
			<p
				v-else-if="state === 'no-access'"
				class="text-muted"
			>
				Your role cannot view pilots.
			</p>

			<template v-else>
				<ul
					v-if="list && list.length > 0"
					class="divide-y divide-default rounded-md border border-default"
				>
					<li
						v-for="pilot in list"
						:key="pilot.id"
						class="flex items-center justify-between gap-3 p-4"
					>
						<NuxtLink
							:to="`/org/pilots/${pilot.id}`"
							class="font-semibold text-default"
							>{{ pilot.name }}</NuxtLink
						>
						<span class="text-sm text-muted"
							>{{ pilot.state }} since {{ pilot.startDate }}</span
						>
					</li>
				</ul>
				<p
					v-else-if="state === 'empty'"
					class="text-muted"
				>
					No pilots yet.
				</p>

				<section
					v-if="canManage"
					class="space-y-4"
				>
					<h2 class="font-semibold text-default">Start a Pilot</h2>
					<form
						class="grid gap-3 sm:grid-cols-2"
						@submit.prevent="create"
					>
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
							<span class="text-sm text-muted">Start Date</span>
							<input
								v-model="form.startDate"
								type="date"
								:class="inputClass"
								required
							/>
						</label>
						<label class="space-y-1">
							<span class="text-sm text-muted">Sponsor</span>
							<input
								v-model="form.sponsor"
								:class="inputClass"
								maxlength="200"
							/>
						</label>
						<label class="space-y-1">
							<span class="text-sm text-muted">Technical Owner</span>
							<input
								v-model="form.technicalOwner"
								:class="inputClass"
								maxlength="200"
							/>
						</label>
						<fieldset class="grid gap-3 sm:col-span-2 sm:grid-cols-3">
							<legend class="mb-1 text-sm text-muted">
								Baseline Before the Pilot
							</legend>
							<label class="space-y-1">
								<span class="text-sm text-muted"
									>Hosting Spend a Month, in Dollars</span
								>
								<input
									v-model="form.hostingDollars"
									type="number"
									min="0"
									step="0.01"
									:class="inputClass"
								/>
							</label>
							<label class="space-y-1">
								<span class="text-sm text-muted">Routine Staff Hours a Month</span>
								<input
									v-model="form.staffHours"
									type="number"
									min="0"
									step="0.5"
									:class="inputClass"
								/>
							</label>
							<label class="space-y-1">
								<span class="text-sm text-muted">Latency, in Milliseconds</span>
								<input
									v-model="form.latencyMs"
									type="number"
									min="0"
									:class="inputClass"
								/>
							</label>
							<label class="space-y-1">
								<span class="text-sm text-muted">Restore Time, in Minutes</span>
								<input
									v-model="form.restoreMinutes"
									type="number"
									min="0"
									:class="inputClass"
								/>
							</label>
							<label class="space-y-1">
								<span class="text-sm text-muted">Rollback Time, in Minutes</span>
								<input
									v-model="form.rollbackMinutes"
									type="number"
									min="0"
									:class="inputClass"
								/>
							</label>
							<label class="space-y-1">
								<span class="text-sm text-muted"
									>Days for a Security Patch to Reach Every Site</span
								>
								<input
									v-model="form.patchDays"
									type="number"
									min="0"
									step="0.5"
									:class="inputClass"
								/>
							</label>
						</fieldset>
						<label class="space-y-1 sm:col-span-2">
							<span class="text-sm text-muted">Success Criteria</span>
							<textarea
								v-model="form.successCriteria"
								rows="3"
								:class="inputClass"
							/>
						</label>
						<button
							type="submit"
							class="justify-self-start rounded-md border border-default px-3 py-2 text-default"
							:disabled="pilots.saving"
						>
							Start Pilot
						</button>
					</form>
					<p
						v-if="pilots.saveError"
						class="text-danger"
						role="alert"
					>
						{{ pilots.saveError.message }}
					</p>
				</section>
			</template>
			<template #fallback>
				<p
					class="text-muted"
					role="status"
				>
					Loading pilots.
				</p>
			</template>
		</ClientOnly>
	</div>
</template>
