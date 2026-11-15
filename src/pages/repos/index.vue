<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import { toApiClientError } from '~/composables/useApi';
import type { CorpusResult, CorpusStatus } from '~/shared/corpus';
import { corpusKey, useCorpusStore } from '~/stores/corpus';
import { useOrgStore } from '~/stores/org';
import { PROVIDER_LABELS, useRepoConnectionsStore } from '~/stores/repo-connections';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Repositories' });

const org = useOrgStore();
const corpus = useCorpusStore();
const repo = useRepoConnectionsStore();

const orgId = computed(() => org.current?.id ?? null);
const orgView = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	return 'ready';
});

const tab = ref<'corpus' | 'connected'>('corpus');
const tabs = [
	{ label: 'Verified Corpus', value: 'corpus' },
	{ label: 'Connected Repositories', value: 'connected' }
];

// #region corpus

const q = ref('');
const status = ref<CorpusStatus | 'all'>('all');
const search = computed(() => ({
	q: q.value.trim() || undefined,
	status: status.value === 'all' ? undefined : status.value
}));

const list = computed(() =>
	orgId.value ? corpus.lists.get(corpusKey(orgId.value, search.value)) : undefined
);
const corpusView = computed(() => {
	if (corpus.error && list.value === undefined) return 'error';
	if (list.value === undefined) return 'loading';
	if (list.value === null) return 'not-found';
	if (list.value.items.length === 0) return 'empty';
	return 'list';
});

watch(
	[orgId, search],
	([id, query]) => {
		if (id) void corpus.load(id, query);
	},
	{ immediate: true, deep: true }
);

function retryCorpus(): void {
	if (orgId.value) void corpus.reload(orgId.value, search.value);
}

const picked = ref<CorpusResult | null>(null);
const dialogOpen = ref(false);

function inspect(item: CorpusResult): void {
	picked.value = item;
	dialogOpen.value = true;
}

// #endregion

// #region connected

const connections = computed(() => (orgId.value ? repo.connections.get(orgId.value) : undefined));
const active = computed(() => (connections.value ?? []).filter((item) => item.state === 'active'));
const connectionView = computed(() => {
	if (connections.value === undefined && repo.connectionsError) return 'error';
	if (connections.value === undefined) return 'loading';
	if (connections.value === null) return 'not-found';
	if (active.value.length === 0) return 'empty';
	return 'list';
});

// keyed by connection id; set when the provider refused the list
const repoErrors = reactive<Record<string, string>>({});

async function loadRepos(id: string, connectionId: string): Promise<void> {
	delete repoErrors[connectionId];
	try {
		await repo.loadRepositories(id, connectionId);
	} catch (cause) {
		repoErrors[connectionId] = toApiClientError(cause).message;
	}
}

watch(
	[orgId, tab],
	([id, current]) => {
		if (id && current === 'connected') void repo.loadConnections(id);
	},
	{ immediate: true }
);

watch(
	active,
	(items) => {
		if (!orgId.value) return;
		for (const item of items) void loadRepos(orgId.value, item.id);
	},
	{ immediate: true }
);

type RepoRow = {
	id: string;
	fullName: string;
	provider: string;
	connection: string;
	defaultBranch: string;
};

const repoFilter = ref('');
const repoRows = computed<RepoRow[]>(() => {
	const needle = repoFilter.value.trim().toLowerCase();
	return active.value.flatMap((item) =>
		(repo.repositories.get(item.id) ?? [])
			.filter((row) => needle === '' || row.fullName.toLowerCase().includes(needle))
			.map((row) => ({
				id: `${item.id}:${row.fullName}`,
				fullName: row.fullName,
				provider: PROVIDER_LABELS[item.provider],
				connection: item.displayName,
				defaultBranch: row.defaultBranch ?? 'Not Reported'
			}))
	);
});
const repoLoading = computed(() =>
	active.value.some(
		(item) => repo.repositories.get(item.id) === undefined && repoErrors[item.id] === undefined
	)
);

const repoColumns: TableColumn<RepoRow>[] = [
	{ accessorKey: 'fullName', header: 'Repository' },
	{ accessorKey: 'provider', header: 'Provider' },
	{ accessorKey: 'connection', header: 'Connection' },
	{ accessorKey: 'defaultBranch', header: 'Default Branch' }
];

// #endregion
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-8">
			<UiPageHeader
				title="Repositories"
				text="Check which verified Drupal codebases can be installed, and see the repositories your organization can use."
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
				<UTabs
					v-model="tab"
					:items="tabs"
					:content="false"
					color="neutral"
					variant="link"
				/>

				<section
					v-if="tab === 'corpus'"
					class="flex flex-col gap-6"
				>
					<RepoSearch
						v-model:q="q"
						v-model:status="status"
					/>

					<UiErrorState
						v-if="corpusView === 'error'"
						title="Could Not Load Codebases"
						:text="corpus.error?.message"
						:request-id="corpus.error?.requestId"
					>
						<UButton
							color="neutral"
							@click="retryCorpus()"
							>Try Again</UButton
						>
					</UiErrorState>
					<UiSkeletonTable
						v-else-if="corpusView === 'loading'"
						label="Loading codebases"
					/>
					<UiEmptyState
						v-else-if="corpusView === 'not-found'"
						icon="i-lucide-building-2"
						title="No Organization Found"
						text="Sign out and sign in again to set up your organization."
					/>
					<UiEmptyState
						v-else-if="corpusView === 'empty'"
						icon="i-lucide-search-x"
						title="No Codebases Match"
						text="Try another name, or choose All Statuses."
					/>
					<RepoCorpusTable
						v-else-if="list"
						:items="list.items"
						:rows="list.rows"
						@inspect="inspect"
					/>
				</section>

				<section
					v-else
					class="flex flex-col gap-6"
				>
					<UiErrorState
						v-if="connectionView === 'error'"
						title="Could Not Load Connections"
						:text="repo.connectionsError?.message"
						:request-id="repo.connectionsError?.requestId"
					>
						<UButton
							color="neutral"
							@click="orgId && repo.loadConnections(orgId)"
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
						title="No Connected Repositories"
						text="Connect a git provider on the Integrations page to see its repositories here."
					/>
					<template v-else>
						<ul
							v-if="Object.keys(repoErrors).length"
							class="flex flex-col gap-3"
						>
							<li
								v-for="(message, connectionId) in repoErrors"
								:key="connectionId"
								role="alert"
								class="flex flex-wrap items-center gap-2 text-sm text-red-700 dark:text-red-400"
							>
								{{ message }}
								<UButton
									color="neutral"
									variant="link"
									@click="orgId && loadRepos(orgId, String(connectionId))"
									>Try Again</UButton
								>
							</li>
						</ul>

						<UInput
							v-model="repoFilter"
							icon="i-lucide-search"
							placeholder="Filter by repository name"
							class="max-w-sm"
						/>

						<UiSkeletonTable
							v-if="repoLoading"
							label="Loading repositories"
						/>
						<UiEmptyState
							v-else-if="
								repoRows.length === 0 && Object.keys(repoErrors).length === 0
							"
							icon="i-lucide-git-branch"
							title="No Repositories Found"
							text="Check the access of each connection on its provider, or change the filter."
						/>
						<UTable
							v-else
							:data="repoRows"
							:columns="repoColumns"
							class="w-full"
						/>
					</template>
				</section>
			</template>
		</div>

		<RepoInstallDialog
			v-model:open="dialogOpen"
			:entry="picked"
		/>
	</ClientOnly>
</template>
