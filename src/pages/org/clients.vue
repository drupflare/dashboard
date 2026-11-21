<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import type { ClientBody, ClientView } from '~/shared/agency';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { useClientsStore } from '~/stores/clients';
import { useOrgStore } from '~/stores/org';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Client Workspaces' });

const org = useOrgStore();
const clients = useClientsStore();

const orgId = computed(() => org.current?.id ?? null);
const actions = computed<readonly string[]>(() => {
	const role = org.current?.role;
	return isOrgRole(role) ? ORG_ROLE_ACTIONS[role] : [];
});
const canRead = computed(() => actions.value.includes('client.read'));
const canManage = computed(() => actions.value.includes('client.manage'));
const canGroupSites = computed(() => actions.value.includes('site.client.manage'));

const state = computed(() => (orgId.value ? clients.lists.get(orgId.value) : undefined));
const items = computed<ClientView[]>(() => state.value?.items ?? []);

const view = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (!canRead.value && org.current) return 'no-access';
	if (state.value === null) return 'no-org';
	if (!state.value || state.value.status === 'loading') return 'loading';
	if (state.value.status === 'error') return 'list-error';
	if (items.value.length === 0) return 'empty';
	return 'list';
});

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const pageError = ref<string | null>(null);

function loadClients(id: string) {
	if (canRead.value) void clients.load(id);
}

onMounted(() => {
	if (orgId.value) loadClients(orgId.value);
});

watch(orgId, (id) => {
	if (id) loadClients(id);
});

function reloadClients() {
	if (orgId.value) void clients.reload(orgId.value);
}

async function attempt(work: () => Promise<unknown>): Promise<boolean> {
	pageError.value = null;
	try {
		await work();
		return true;
	} catch (cause) {
		pageError.value = toApiClientError(cause).message;
		return false;
	}
}

// the client form serves both create and edit
const formOpen = ref(false);
const formBusy = ref(false);
const formError = ref<string | null>(null);
const editing = ref<ClientView | null>(null);
const draft = reactive({
	name: '',
	contactName: '',
	contactEmail: '',
	notes: '',
	contractNotes: ''
});

function openForm(client: ClientView | null) {
	editing.value = client;
	formError.value = null;
	draft.name = client?.name ?? '';
	draft.contactName = client?.contactName ?? '';
	draft.contactEmail = client?.contactEmail ?? '';
	draft.notes = client?.notes ?? '';
	draft.contractNotes = client?.contractNotes ?? '';
	formOpen.value = true;
}

function bodyOf(): ClientBody {
	const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
	return {
		name: draft.name.trim(),
		contactName: orNull(draft.contactName),
		contactEmail: orNull(draft.contactEmail),
		notes: orNull(draft.notes),
		contractNotes: orNull(draft.contractNotes)
	};
}

async function saveClient() {
	if (!orgId.value) return;
	formBusy.value = true;
	const id = orgId.value;
	const ok = await attempt(() =>
		editing.value
			? clients.update(id, editing.value.id, bodyOf())
			: clients.create(id, bodyOf())
	);
	formBusy.value = false;
	if (ok) {
		formOpen.value = false;
		reloadClients();
	} else {
		formError.value = pageError.value;
	}
}

async function deleteClient(client: ClientView) {
	if (!orgId.value) return;
	if (!window.confirm(`Delete ${client.name}? The sites stay in this organization.`)) return;
	await attempt(() => clients.remove(orgId.value as string, client.id));
}

// grouping a site moves it under one client; the site stays in this organization
const groupOpen = ref(false);
const groupSite = ref('');
const groupClient = ref('');
const groupError = ref<string | null>(null);

function openGroup(clientId = '') {
	groupSite.value = '';
	groupClient.value = clientId;
	groupError.value = null;
	groupOpen.value = true;
}

async function groupSiteUnder() {
	if (!orgId.value) return;
	const site = groupSite.value.trim();
	if (!site || !groupClient.value) {
		groupError.value = 'Choose a client and enter a site ID.';
		return;
	}
	const ok = await attempt(() => clients.addSite(orgId.value as string, site, groupClient.value));
	if (ok) groupOpen.value = false;
	else groupError.value = pageError.value;
}

async function removeSite(client: ClientView, siteId: string) {
	if (!orgId.value) return;
	await attempt(() => clients.removeSite(orgId.value as string, siteId, client.id));
}

// the usage export is a file download, so it goes through the browser rather than the store
const usageFrom = ref('');
const usageTo = ref('');

function usageHref(client: ClientView): string {
	const query = new URLSearchParams({ from: usageFrom.value, to: usageTo.value });
	return `/api/v1/orgs/${encodeURIComponent(orgId.value ?? '')}/clients/${encodeURIComponent(client.id)}/usage?${query}`;
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Client Workspaces"
				text="Group the sites you run for each client, and note who the end customer contacts for incidents, migrations, refunds and restores."
			>
				<div
					v-if="orgId && (canManage || canGroupSites)"
					class="flex gap-2"
				>
					<UButton
						v-if="canGroupSites && items.length"
						color="neutral"
						variant="outline"
						@click="openGroup()"
						>Group a Site</UButton
					>
					<UButton
						v-if="canManage"
						@click="openForm(null)"
						>Add a Client</UButton
					>
				</div>
			</UiPageHeader>

			<UiErrorState
				v-if="view === 'org-error'"
				title="Could Not Load Organizations"
				:text="org.error?.message"
				:request-id="org.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="org.load()"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiEmptyState
				v-else-if="view === 'no-org'"
				icon="i-lucide-building-2"
				title="No Organization Found"
				text="Sign out and sign in again to set up your organization."
			/>

			<UiEmptyState
				v-else-if="view === 'no-access'"
				icon="i-lucide-lock"
				title="Your Role Cannot See Clients"
				text="Ask an owner or an admin of this organization to share this view with you."
			/>

			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading client workspaces"
			/>

			<UiErrorState
				v-else-if="view === 'list-error'"
				title="Could Not Load Clients"
				:text="state?.error?.message"
				:request-id="state?.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="reloadClients"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiEmptyState
				v-else-if="view === 'empty'"
				icon="i-lucide-users"
				title="No Clients Yet"
				text="Add a client to group its sites and record who handles its incidents and refunds."
			>
				<UButton
					v-if="canManage"
					@click="openForm(null)"
					>Add a Client</UButton
				>
			</UiEmptyState>

			<template v-else>
				<p
					v-if="pageError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ pageError }}
				</p>

				<section
					v-if="canRead"
					class="flex flex-wrap items-end gap-3 text-sm"
				>
					<label class="flex flex-col gap-1">
						<span class="font-medium text-highlighted">Usage From</span>
						<input
							v-model="usageFrom"
							:class="inputClass"
							type="month"
						/>
					</label>
					<label class="flex flex-col gap-1">
						<span class="font-medium text-highlighted">Usage To</span>
						<input
							v-model="usageTo"
							:class="inputClass"
							type="month"
						/>
					</label>
				</section>

				<div
					v-for="client in items"
					:key="client.id"
					class="flex flex-col gap-2"
				>
					<AgencyClientCard
						:client="client"
						:can-manage="canManage"
						:can-group="canGroupSites"
						@edit="openForm(client)"
						@delete="deleteClient(client)"
						@remove-site="removeSite(client, $event)"
					/>
					<div
						v-if="canRead && usageFrom && usageTo"
						class="flex justify-end"
					>
						<UButton
							:href="usageHref(client)"
							color="neutral"
							variant="outline"
							>Download Usage CSV</UButton
						>
					</div>
				</div>
			</template>

			<UModal
				v-model:open="formOpen"
				:title="editing ? 'Edit Client' : 'Add a Client'"
				description="Only your organization sees these notes."
			>
				<template #body>
					<form
						class="flex flex-col gap-4"
						novalidate
						@submit.prevent="saveClient"
					>
						<label class="flex flex-col gap-1 text-sm">
							<span class="font-medium text-highlighted">Client Name</span>
							<input
								v-model="draft.name"
								:class="inputClass"
								type="text"
								required
							/>
						</label>
						<label class="flex flex-col gap-1 text-sm">
							<span class="font-medium text-highlighted">Contact Name</span>
							<input
								v-model="draft.contactName"
								:class="inputClass"
								type="text"
							/>
						</label>
						<label class="flex flex-col gap-1 text-sm">
							<span class="font-medium text-highlighted">Contact Email</span>
							<input
								v-model="draft.contactEmail"
								:class="inputClass"
								type="email"
							/>
						</label>
						<label class="flex flex-col gap-1 text-sm">
							<span class="font-medium text-highlighted"
								>Who the End Customer Contacts</span
							>
							<span class="text-muted"
								>Incidents, migrations, refunds and restores.</span
							>
							<textarea
								v-model="draft.notes"
								:class="inputClass"
								rows="3"
							></textarea>
						</label>
						<label class="flex flex-col gap-1 text-sm">
							<span class="font-medium text-highlighted">Contract Notes</span>
							<textarea
								v-model="draft.contractNotes"
								:class="inputClass"
								rows="3"
							></textarea>
						</label>
						<p
							v-if="formError"
							role="alert"
							class="text-sm text-red-700 dark:text-red-400"
						>
							{{ formError }}
						</p>
						<div class="flex justify-end">
							<UButton
								type="submit"
								:loading="formBusy"
								>Save Client</UButton
							>
						</div>
					</form>
				</template>
			</UModal>

			<UModal
				v-model:open="groupOpen"
				title="Group a Site"
				description="A site sits under one client at a time."
			>
				<template #body>
					<form
						class="flex flex-col gap-4"
						novalidate
						@submit.prevent="groupSiteUnder"
					>
						<label class="flex flex-col gap-1 text-sm">
							<span class="font-medium text-highlighted">Client</span>
							<select
								v-model="groupClient"
								:class="inputClass"
							>
								<option
									value=""
									disabled
								>
									Choose a client
								</option>
								<option
									v-for="client in items"
									:key="client.id"
									:value="client.id"
								>
									{{ client.name }}
								</option>
							</select>
						</label>
						<label class="flex flex-col gap-1 text-sm">
							<span class="font-medium text-highlighted">Site ID</span>
							<input
								v-model="groupSite"
								:class="inputClass"
								type="text"
								autocomplete="off"
							/>
						</label>
						<p
							v-if="groupError"
							role="alert"
							class="text-sm text-red-700 dark:text-red-400"
						>
							{{ groupError }}
						</p>
						<div class="flex justify-end">
							<UButton type="submit">Group Site</UButton>
						</div>
					</form>
				</template>
			</UModal>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full" />
		</template>
	</ClientOnly>
</template>
