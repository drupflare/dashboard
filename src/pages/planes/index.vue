<script setup lang="ts">
definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Nodes' });

const session = useSessionStore();
const org = useOrgStore();
const nodes = useNodesStore();

const orgId = computed(() => org.current?.id ?? null);
const list = computed(() => (orgId.value ? nodes.lists.get(orgId.value) : undefined));
const items = computed(() => list.value?.items ?? []);

const view = computed(() => {
	if (session.me === undefined && session.error) return 'session-error';
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (!list.value || (list.value.status === 'loading' && items.value.length === 0)) {
		return 'loading';
	}
	if (items.value.length === 0 && list.value.status === 'error') return 'nodes-error';
	if (items.value.length === 0) return 'empty';
	return 'list';
});

function loadNodes(id: string) {
	void nodes.load(id);
}

onMounted(() => {
	if (orgId.value) loadNodes(orgId.value);
});

watch(orgId, (id) => {
	if (id) loadNodes(id);
});

function reloadNodes() {
	if (orgId.value) void nodes.reload(orgId.value);
}

function loadMore() {
	if (orgId.value) void nodes.loadMore(orgId.value);
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Nodes"
				text="Servers you run yourself. A paired node reports its status and takes commands, and keeps running on its own if you revoke it."
			>
				<NodePairDialog
					v-if="orgId"
					:org-id="orgId"
					@closed="reloadNodes()"
				/>
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
				label="Loading nodes"
			/>

			<UiErrorState
				v-else-if="view === 'nodes-error'"
				title="Could Not Load Nodes"
				:text="list?.error?.message"
				:request-id="list?.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="reloadNodes"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiEmptyState
				v-else-if="view === 'empty'"
				icon="i-lucide-server"
				title="No Nodes Yet"
				text="Pair a box that runs Bastion to see its status here."
			/>

			<template v-else>
				<ul class="flex flex-col gap-3">
					<NodeRow
						v-for="node in items"
						:key="node.id"
						:org-id="orgId ?? ''"
						:node="node"
					/>
				</ul>
				<p
					v-if="list?.status === 'error'"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					Could not load more nodes.
					<UButton
						color="neutral"
						variant="link"
						@click="loadMore"
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
						>Load More</UButton
					>
				</div>
			</template>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full" />
		</template>
	</ClientOnly>
</template>
