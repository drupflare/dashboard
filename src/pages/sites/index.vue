<script setup lang="ts">
definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Sites' });

const session = useSessionStore();
const org = useOrgStore();
const sites = useSitesStore();

const orgId = computed(() => org.current?.id ?? null);
const list = computed(() => (orgId.value ? sites.lists.get(orgId.value) : undefined));
const visible = computed(() => (orgId.value ? sites.forOrg(orgId.value) : []));

const view = computed(() => {
	if (session.me === undefined && session.error) return 'session-error';
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (!list.value || (list.value.status === 'loading' && visible.value.length === 0)) {
		return 'loading';
	}
	if (visible.value.length === 0 && list.value.status === 'error') return 'sites-error';
	if (visible.value.length === 0) return 'empty';
	return 'list';
});

function loadSites(id: string) {
	void sites.load(id);
}

onMounted(() => {
	if (orgId.value) loadSites(orgId.value);
});

watch(orgId, (id) => {
	if (id) loadSites(id);
});

function loadMore() {
	if (orgId.value) void sites.loadMore(orgId.value);
}

function reloadSites() {
	if (orgId.value) void sites.reload(orgId.value);
}

function retryPage() {
	if (visible.value.length) loadMore();
	else reloadSites();
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Sites"
				:text="org.current?.name"
			>
				<UButton
					v-if="view === 'list'"
					to="/new"
					icon="i-lucide-plus"
					>Create a Site</UButton
				>
			</UiPageHeader>

			<UiErrorState
				v-if="view === 'session-error'"
				title="Could Not Load Your Account"
				:text="session.error?.message"
				:request-id="session.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="session.load()"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiErrorState
				v-else-if="view === 'org-error'"
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

			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading sites"
			/>

			<UiErrorState
				v-else-if="view === 'sites-error'"
				title="Could Not Load Sites"
				:text="list?.error?.message"
				:request-id="list?.error?.requestId"
			>
				<p
					v-if="list?.error?.code === 'unauthenticated'"
					class="text-sm"
				>
					<NuxtLink
						to="/login"
						class="font-medium text-brand-700 underline dark:text-brand-300"
					>
						Sign In
					</NuxtLink>
				</p>
				<UButton
					v-else
					color="neutral"
					@click="reloadSites"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiEmptyState
				v-else-if="view === 'empty'"
				icon="i-lucide-globe"
				title="No Sites Yet"
				text="Create a site to start hosting in this organization."
			>
				<UButton
					to="/new"
					icon="i-lucide-plus"
					>Create a Site</UButton
				>
			</UiEmptyState>

			<template v-else>
				<SiteTable :sites="visible" />
				<ul class="flex flex-col gap-3 md:hidden">
					<SiteCard
						v-for="site in visible"
						:key="site.id"
						:site="site"
					/>
				</ul>
				<p
					v-if="list?.status === 'error'"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					Could not load more sites.
					<UButton
						color="neutral"
						variant="link"
						@click="retryPage"
						>Try Again</UButton
					>
				</p>
				<div
					v-if="list?.nextCursor"
					class="flex justify-center"
				>
					<UButton
						color="neutral"
						variant="outline"
						:loading="list.status === 'loading'"
						@click="loadMore"
					>
						Load More
					</UButton>
				</div>
			</template>
		</div>
		<template #fallback>
			<div class="flex flex-col gap-6">
				<UiPageHeader title="Sites" />
				<UiSkeletonTable label="Loading sites" />
			</div>
		</template>
	</ClientOnly>
</template>
