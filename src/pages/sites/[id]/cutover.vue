<script setup lang="ts">
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import type { CutoverChoiceName, CutoverPolicyName } from '~/shared/cutover-copy';
import { formatObservation, SIGN_IN_COUNTS } from '~/shared/cutover-copy';
import { cutoverRefusalReason } from '~/shared/operation-copy';
import { useCutoverStore } from '~/stores/cutover';
import { useSessionStore } from '~/stores/session';
import type { SiteSummary } from '~/stores/sites';

definePageMeta({ middleware: ['auth'] });

const route = useRoute();
const siteId = String(route.params.id);
const store = useCutoverStore();
const session = useSessionStore();

const site = ref<SiteSummary | null>(null);
const siteError = ref<ApiClientError | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const needsStepUp = ref(false);
let pending: (() => Promise<void>) | null = null;
let idempotencyKey = crypto.randomUUID();

const orgId = computed(() => site.value?.orgId ?? null);
const payload = computed(() => store.bySite.get(siteId));
const loadError = computed(() => store.errors.get(siteId) ?? null);
const view = computed(() => payload.value?.cutover ?? null);
const active = computed(
	() => view.value !== null && !['completed', 'rolled-back', 'failed'].includes(view.value.state)
);

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

async function load(): Promise<void> {
	if (orgId.value === null) return;
	try {
		await store.read(orgId.value, siteId);
	} catch {
		// the failure is kept in the store for the screen to show
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

// the move runs in the engine, so the page reads it again while it is not finished
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
	void loadSite();
	timer = setInterval(() => {
		if (active.value) void load();
	}, 10_000);
});
onBeforeUnmount(() => clearInterval(timer));

useHead({ title: () => (site.value ? `Move ${site.value.name}` : 'Move a Site') });

async function guarded(action: () => Promise<void>): Promise<void> {
	error.value = null;
	if (!fresh()) {
		pending = action;
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		await action();
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { requires?: string } | null;
		if (details?.requires === 'step-up') {
			pending = action;
			needsStepUp.value = true;
		} else {
			error.value = cutoverRefusalReason(failure);
		}
	} finally {
		busy.value = false;
	}
}

function start(body: {
	policy: CutoverPolicyName;
	source: { ref: string };
	hostname: string;
}): Promise<void> {
	const org = orgId.value;
	if (org === null) return Promise.resolve();
	return guarded(() => store.start(org, siteId, body, idempotencyKey));
}

function approve(): Promise<void> {
	const org = orgId.value;
	if (org === null) return Promise.resolve();
	return guarded(() => store.approve(org, siteId));
}

function choose(value: CutoverChoiceName | 'rollback'): Promise<void> {
	const org = orgId.value;
	if (org === null) return Promise.resolve();
	return guarded(() => store.choose(org, siteId, value));
}

function stepUpDone(): void {
	needsStepUp.value = false;
	const action = pending;
	pending = null;
	if (action) void guarded(action);
}

const siteMissing = computed(() => siteError.value?.status === 404);
const downloadUrl = computed(() =>
	orgId.value === null
		? undefined
		: `/api/v1/orgs/${encodeURIComponent(orgId.value)}/sites/${encodeURIComponent(siteId)}/cutover/changes`
);
const points = computed(() => (payload.value?.observationOffsetsMs ?? []).map(formatObservation));
</script>

<template>
	<ClientOnly>
		<div class="flex max-w-3xl flex-col gap-6">
			<UiEmptyState
				v-if="siteMissing"
				icon="i-lucide-search-x"
				title="Site Not Found"
				text="Check the link, or pick a site from your list."
			>
				<UButton
					color="neutral"
					to="/sites"
				>
					Back to Sites
				</UButton>
			</UiEmptyState>

			<UiErrorState
				v-else-if="siteError || loadError"
				title="Could Not Load the Move"
				:text="(siteError ?? loadError)?.message ?? ''"
				:request-id="(siteError ?? loadError)?.requestId"
			>
				<UButton
					color="neutral"
					@click="loadSite()"
				>
					Try Again
				</UButton>
			</UiErrorState>

			<SiteSkeleton v-else-if="!site || payload === undefined" />

			<template v-else>
				<div class="flex flex-col gap-1">
					<h1 class="text-2xl font-semibold text-highlighted">Move {{ site.name }}</h1>
					<p class="text-sm text-default">
						Your old site is never deleted. If you change your mind, it is still there.
					</p>
				</div>

				<UiEmptyState
					v-if="payload && !payload.ready"
					icon="i-lucide-circle-slash"
					title="This Site Cannot Take a Move"
					text="Only a live managed site with an address of its own can be moved to."
				/>

				<UiEmptyState
					v-else-if="payload && !payload.available && !view"
					icon="i-lucide-clock"
					title="Moves Are Not Available Yet"
					text="Drupflare cannot connect to the old site for you yet. You can read the plan, but not start a move."
				/>

				<template v-else-if="payload && view">
					<div
						v-if="view.state === 'awaiting-approval'"
						class="flex flex-col gap-2 rounded-lg border border-default p-4"
					>
						<p class="text-sm text-default">
							The new site matches your old site. Approving starts the switch.
						</p>
						<p
							class="text-sm text-default"
							data-test="sign-in"
						>
							{{ SIGN_IN_COUNTS }}
						</p>
						<SiteCutoverWindow
							:policy="view.policy"
							:seconds="view.expectedWindowSeconds"
						/>
						<div>
							<UButton
								:loading="busy"
								:disabled="busy"
								@click="approve()"
								>Approve the Move</UButton
							>
						</div>
					</div>

					<p
						v-if="view.reason"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ view.reason }}
					</p>

					<SiteCutoverBoundary
						:view="view"
						:busy="busy"
						:download-url="downloadUrl"
						@choose="choose"
					/>

					<p
						v-if="points.length > 0"
						class="text-sm text-muted"
					>
						After the switch, Drupflare checks the new site at {{ points.join(', ') }}.
					</p>
				</template>

				<SiteCutoverPlan
					v-else-if="payload"
					:plan="payload"
					:busy="busy"
					:error="error"
					@start="start"
				/>

				<p
					v-if="error && view"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ error }}
				</p>

				<AccountStepUp
					v-if="needsStepUp"
					@done="stepUpDone()"
					@cancel="needsStepUp = false"
				/>
			</template>
		</div>
		<template #fallback>
			<SiteSkeleton />
		</template>
	</ClientOnly>
</template>
