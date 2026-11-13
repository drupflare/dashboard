<script setup lang="ts">
import { toApiClientError, type ApiClientError } from '~/composables/useApi';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { PROVIDER_IDS, type ConnectionView, type ProviderId } from '~/shared/repo-connections';
import { useOrgStore } from '~/stores/org';
import {
	PROVIDER_LABELS,
	useRepoConnectionsStore,
	type RemoteInput
} from '~/stores/repo-connections';
import { useSessionStore } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Integrations' });

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const org = useOrgStore();
const sites = useSitesStore();
const repo = useRepoConnectionsStore();

const providerNamed = (value: unknown): ProviderId | null =>
	typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
		? (value as ProviderId)
		: null;

// the callback returns to this page with ?connected=<provider>; the query goes once the banner is read
const connectedProvider = providerNamed(route.query.connected);

// only GitHub connects today; the other providers show as coming soon
const cards = PROVIDER_IDS.map((id) => ({
	id,
	label: PROVIDER_LABELS[id],
	available: id === 'github',
	text: id === 'github' ? 'Pick the repositories to share with Drupflare on GitHub.' : undefined
}));

const orgId = computed(() => org.current?.id ?? null);
const actions = computed<readonly string[]>(() => {
	const role = org.current?.role;
	return isOrgRole(role) ? ORG_ROLE_ACTIONS[role] : [];
});
const canConnect = computed(() => actions.value.includes('repo.connect'));
const canAttach = computed(() => actions.value.includes('site.remote.manage'));

const orgView = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	return 'ready';
});

const connections = computed(() => (orgId.value ? repo.connections.get(orgId.value) : undefined));
const connectionRows = computed<ConnectionView[]>(() => connections.value ?? []);
const activeConnections = computed(() =>
	connectionRows.value.filter((item) => item.state === 'active')
);

const connectionView = computed(() => {
	if (connections.value === undefined && repo.connectionsError) return 'connections-error';
	if (connections.value === undefined) return 'loading';
	if (connections.value === null) return 'not-found';
	if (connections.value.length === 0) return 'empty';
	return 'list';
});
const attachReady = computed(
	() => connectionView.value === 'list' && activeConnections.value.length > 0
);

const siteList = computed(() => (orgId.value ? sites.lists.get(orgId.value) : undefined));
const siteOptions = computed(() =>
	(orgId.value ? sites.forOrg(orgId.value) : []).map((site) => ({
		label: site.name,
		value: site.id
	}))
);
const pickedSite = ref<string>();
const siteId = computed<string | undefined>({
	get: () => {
		const picked = pickedSite.value;
		if (picked && siteOptions.value.some((item) => item.value === picked)) return picked;
		return siteOptions.value[0]?.value;
	},
	set: (value) => {
		pickedSite.value = value;
	}
});
const siteView = computed(() => {
	if (siteList.value?.status === 'error') return 'sites-error';
	if (siteList.value === undefined || siteList.value.status === 'loading') return 'loading';
	if (siteOptions.value.length === 0) return 'no-sites';
	return 'list';
});

const remotes = computed(() => (siteId.value ? repo.remotes.get(siteId.value) : undefined));
const remoteRows = computed(() => remotes.value ?? []);
const remoteView = computed(() => {
	if (siteId.value === undefined) return 'loading';
	if (remotes.value === undefined && repo.remotesError) return 'remotes-error';
	if (remotes.value === undefined) return 'loading';
	if (remotes.value === null) return 'site-not-found';
	if (remotes.value.length === 0) return 'empty';
	return 'list';
});

const actionError = ref<ApiClientError | null>(null);
// the key of the request in flight; one at a time, so a double click cannot start two
const busy = ref<string | null>(null);
// the retry to run once a fresh sign-in is confirmed
const waiting = ref<(() => Promise<void>) | null>(null);
const attachBusy = ref(false);
const attachError = ref<string | null>(null);

function loadAll(id: string): void {
	void repo.loadConnections(id);
	void sites.load(id);
}

onMounted(() => {
	if (orgId.value) loadAll(orgId.value);
	if (route.query.connected === undefined) return;
	const query = { ...route.query };
	delete query.connected;
	void router.replace({ query });
});

watch(orgId, (id) => {
	if (id) loadAll(id);
});

watch(
	siteId,
	(id) => {
		if (id && orgId.value) void repo.loadRemotes(orgId.value, id);
	},
	{ immediate: true }
);

function fresh(): boolean {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
}

// connecting and revoking need a fresh sign-in; a stale one waits for the code, then runs
async function guarded(key: string, run: () => Promise<void>): Promise<void> {
	actionError.value = null;
	if (!fresh()) {
		waiting.value = () => guarded(key, run);
		return;
	}
	busy.value = key;
	try {
		await run();
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { requires?: string } | null;
		if (details?.requires === 'step-up') waiting.value = () => guarded(key, run);
		else actionError.value = failure;
	} finally {
		busy.value = null;
	}
}

function stepUpDone(): void {
	const retry = waiting.value;
	waiting.value = null;
	if (retry) void retry();
}

function connect(provider: ProviderId): void {
	const id = orgId.value;
	if (!id) return;
	void guarded(`connect:${provider}`, async () => {
		const start = await repo.startConnect(id, provider);
		if (start.kind === 'redirect') await navigateTo(start.url, { external: true });
		else await repo.reloadConnections(id);
	});
}

function revoke(item: ConnectionView): void {
	const id = orgId.value;
	if (!id) return;
	void guarded(`revoke:${item.id}`, () => repo.revoke(id, item.id));
}

function reloadConnections(): void {
	if (orgId.value) void repo.loadConnections(orgId.value);
}

function retryRemotes(): void {
	if (orgId.value && siteId.value) void repo.loadRemotes(orgId.value, siteId.value);
}

async function attach(input: RemoteInput): Promise<void> {
	const id = orgId.value;
	const site = siteId.value;
	if (!id || !site) return;
	attachError.value = null;
	attachBusy.value = true;
	try {
		await repo.attachRemote(id, site, input);
	} catch (cause) {
		attachError.value = toApiClientError(cause).message;
	} finally {
		attachBusy.value = false;
	}
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-8">
			<UiPageHeader
				title="Integrations"
				text="Connect the git providers that hold your site code, then attach a repository to a site."
			/>

			<UiErrorState
				v-if="orgView === 'org-error'"
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
				v-else-if="orgView === 'no-org'"
				icon="i-lucide-building-2"
				title="No Organization Found"
				text="Sign out and sign in again to set up your organization."
			/>

			<template v-else>
				<p
					v-if="connectedProvider"
					role="status"
					class="text-sm text-green-700 dark:text-green-400"
				>
					{{ PROVIDER_LABELS[connectedProvider] }} is connected. Attach a repository to a
					site below.
				</p>
				<p
					v-if="actionError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ actionError.message }}
				</p>
				<AccountStepUp
					v-if="waiting"
					@done="stepUpDone()"
					@cancel="waiting = null"
				/>

				<section class="flex flex-col gap-4">
					<h2 class="text-lg font-semibold text-highlighted">Git Providers</h2>
					<ul class="grid gap-3 sm:grid-cols-2">
						<IntegrationsProviderCard
							v-for="card in cards"
							:key="card.id"
							:label="card.label"
							:available="card.available"
							:can-connect="canConnect"
							:busy="busy === `connect:${card.id}`"
							:text="card.text"
							@connect="connect(card.id)"
						/>
					</ul>
				</section>

				<section class="flex flex-col gap-4">
					<h2 class="text-lg font-semibold text-highlighted">Connections</h2>
					<UiErrorState
						v-if="connectionView === 'connections-error'"
						title="Could Not Load Connections"
						:text="repo.connectionsError?.message"
						:request-id="repo.connectionsError?.requestId"
					>
						<UButton
							color="neutral"
							@click="reloadConnections()"
							>Try Again</UButton
						>
					</UiErrorState>
					<UiSkeletonTable
						v-else-if="connectionView === 'loading'"
						label="Loading connections"
					/>
					<UiEmptyState
						v-else-if="connectionView === 'not-found'"
						icon="i-lucide-building-2"
						title="No Organization Found"
						text="Sign out and sign in again to set up your organization."
					/>
					<UiEmptyState
						v-else-if="connectionView === 'empty'"
						icon="i-lucide-plug"
						title="No Connections Yet"
						text="Connect GitHub above to pick repositories for your sites."
					/>
					<ul
						v-else
						class="flex flex-col gap-3"
					>
						<IntegrationsConnectionRow
							v-for="item in connectionRows"
							:key="item.id"
							:connection="item"
							:can-revoke="canConnect"
							:busy="busy === `revoke:${item.id}`"
							@revoke="revoke(item)"
						/>
					</ul>
				</section>

				<section class="flex flex-col gap-4">
					<h2 class="text-lg font-semibold text-highlighted">Attach a Repository</h2>
					<UiErrorState
						v-if="siteView === 'sites-error'"
						title="Could Not Load Sites"
						:text="siteList?.error?.message"
						:request-id="siteList?.error?.requestId"
					>
						<UButton
							color="neutral"
							@click="orgId && sites.reload(orgId)"
							>Try Again</UButton
						>
					</UiErrorState>
					<UiSkeletonTable
						v-else-if="siteView === 'loading'"
						label="Loading sites"
					/>
					<UiEmptyState
						v-else-if="siteView === 'no-sites'"
						icon="i-lucide-globe"
						title="No Sites Yet"
						text="Create a site before you attach a repository to it."
					/>
					<template v-else>
						<UFormField
							label="Site"
							class="max-w-sm"
						>
							<USelect
								v-model="siteId"
								:items="siteOptions"
								class="w-full"
							/>
						</UFormField>

						<p
							v-if="!canAttach"
							class="text-sm text-muted"
						>
							Only organization owners, admins and developers can attach a repository.
						</p>
						<p
							v-else-if="
								!attachReady &&
								(connectionView === 'empty' || connectionView === 'list')
							"
							class="text-sm text-muted"
						>
							Connect a provider above before you attach a repository.
						</p>
						<IntegrationsAttachForm
							v-else-if="canAttach && attachReady && orgId"
							:org-id="orgId"
							:connections="activeConnections"
							:busy="attachBusy"
							:error="attachError"
							@attach="attach"
						/>

						<div class="flex flex-col gap-3">
							<h3 class="font-medium text-highlighted">Repositories on This Site</h3>
							<UiErrorState
								v-if="remoteView === 'remotes-error'"
								title="Could Not Load Attached Repositories"
								:text="repo.remotesError?.message"
								:request-id="repo.remotesError?.requestId"
							>
								<UButton
									color="neutral"
									@click="retryRemotes()"
									>Try Again</UButton
								>
							</UiErrorState>
							<UiSkeletonTable
								v-else-if="remoteView === 'loading'"
								label="Loading attached repositories"
							/>
							<UiEmptyState
								v-else-if="remoteView === 'site-not-found'"
								icon="i-lucide-circle-slash"
								title="Site Not Found"
								text="This site could not be found in your organization."
							/>
							<UiEmptyState
								v-else-if="remoteView === 'empty'"
								icon="i-lucide-git-branch"
								title="Nothing Attached Yet"
								text="Attach a repository above. Its last pull shows here."
							/>
							<ul
								v-else
								class="flex flex-col gap-3"
							>
								<IntegrationsRemoteRow
									v-for="item in remoteRows"
									:key="item.id"
									:remote="item"
								/>
							</ul>
						</div>
					</template>
				</section>
			</template>
		</div>
	</ClientOnly>
</template>
