<script setup lang="ts">
import { usePoll } from '~/composables/usePoll';
import { useHealthStore } from '~/stores/health';

const props = defineProps<{ orgId: string; siteId: string }>();

const store = useHealthStore();
const health = computed(() => store.bySite.get(props.siteId));
const failure = computed(() => store.errors.get(props.siteId) ?? null);

// the server keeps a read for 15 seconds, so a faster poll would only repeat it
const poll = usePoll(() => store.fetchOne(props.orgId, props.siteId), {
	minMs: 15_000,
	maxMs: 60_000
});

onMounted(() => poll.start());
watch(
	() => [props.orgId, props.siteId],
	() => void poll.refresh()
);

const clear = computed(
	() => health.value?.status === 'healthy' && health.value.nodes.every((n) => n.level === 'ok')
);

const checkedAt = computed(() =>
	health.value ? `${health.value.observedAt.slice(0, 16).replace('T', ' ')} UTC` : ''
);
</script>

<template>
	<section
		class="flex flex-col gap-4"
		aria-labelledby="site-health-title"
		:aria-busy="health === undefined && failure === null"
	>
		<h2
			id="site-health-title"
			class="text-lg font-semibold text-highlighted"
		>
			Site Health
		</h2>

		<UiErrorState
			v-if="health === undefined && failure"
			title="Health Unavailable"
			:text="failure.message"
			:request-id="failure.requestId"
		/>

		<p
			v-else-if="health === undefined"
			class="inline-flex items-center gap-2 text-sm text-muted"
			role="status"
		>
			<UIcon
				name="i-lucide-loader-circle"
				class="size-4 animate-spin"
				aria-hidden="true"
			/>
			Checking the site
		</p>

		<template v-else-if="health">
			<div class="flex flex-col gap-1">
				<HealthVerdict
					:status="health.status"
					:level="health.level"
				/>
				<p
					v-if="health.reason"
					class="text-sm text-muted"
					data-test="reason"
				>
					{{ health.reason }}
				</p>
				<p
					v-if="health.step"
					class="text-sm text-muted"
					data-test="step"
				>
					{{ health.step }}
				</p>
				<p
					v-if="failure"
					class="text-sm text-amber-800 dark:text-amber-300"
				>
					The last check failed, so this is the previous result. {{ failure.message }}
				</p>
				<p class="text-xs text-muted">Last checked {{ checkedAt }}</p>
			</div>

			<UiEmptyState
				v-if="clear"
				icon="i-lucide-circle-check"
				title="Nothing to Fix"
				text="Every check passed on the last read."
			/>

			<ul
				v-else-if="health.nodes.length > 0"
				class="flex flex-col divide-y divide-default rounded-lg border border-default px-4"
			>
				<HealthTreeNode
					v-for="node in health.nodes"
					:key="node.id"
					:node="node"
				/>
			</ul>
		</template>
	</section>
</template>
