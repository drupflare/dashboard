<script setup lang="ts">
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import {
	HELD_COPY,
	ROUTING_LATER_COPY,
	WAITING_DNS_COPY,
	WAITING_DNS_TITLE,
	domainRefusalReason
} from '~/shared/domain-copy';
import { useDomainStore, type DomainCheck } from '~/stores/domain';
import { useSessionStore } from '~/stores/session';
import type { SiteSummary } from '~/stores/sites';

definePageMeta({ middleware: ['auth'] });

const route = useRoute();
const siteId = String(route.params.id);
const store = useDomainStore();
const session = useSessionStore();

const site = ref<SiteSummary | null>(null);
const siteError = ref<ApiClientError | null>(null);
const busy = ref(false);
const checking = ref(false);
const error = ref<string | null>(null);
// the live read of the records for the domain the owner asked about, or the one being attached
const checked = ref<DomainCheck | null>(null);
const checkedHost = ref<string | null>(null);
const needsStepUp = ref(false);
let pending: (() => Promise<void>) | null = null;
let idempotencyKey = crypto.randomUUID();

const orgId = computed(() => site.value?.orgId ?? null);
const payload = computed(() => store.bySite.get(siteId));
const loadError = computed(() => store.errors.get(siteId) ?? null);
const view = computed(() => payload.value?.attach ?? null);
const running = computed(() => view.value?.status === 'running');
// the owner still has to add the ownership record, so the name is held for them until a date
const waitingForRecord = computed(() => running.value && view.value?.expiresAt != null);
const expiryDate = computed(() =>
	view.value?.expiresAt == null ? null : dateFormat.format(new Date(view.value.expiresAt))
);
const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
// a finished attach, failed or not, gives way to the form so the owner can start again
const showForm = computed(() => !running.value);
// the records of a live attach are read for its domain, and otherwise for the one typed in the form
const watched = computed(() =>
	view.value && view.value.status !== 'succeeded' ? view.value.hostname : checkedHost.value
);
const shown = computed(() => {
	const current = checked.value;
	if (current !== null && current.hostname === watched.value) return current;
	return null;
});

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
		if (view.value && view.value.status !== 'succeeded') void check(view.value.hostname);
	} catch (failure) {
		siteError.value = toApiClientError(failure);
	}
}

async function check(hostname: string): Promise<void> {
	const org = orgId.value;
	if (org === null) return;
	checkedHost.value = hostname;
	checking.value = true;
	error.value = null;
	try {
		const result = await store.check(org, siteId, hostname);
		checked.value = result;
		if (result.held) error.value = HELD_COPY;
	} catch (cause) {
		error.value = domainRefusalReason(toApiClientError(cause));
	} finally {
		checking.value = false;
	}
}

// the attach waits in the engine for the owner's DNS, so the page reads it again while it runs, and
// checks the records again while the owner stays
let timer: ReturnType<typeof setInterval> | undefined;
let recheck: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
	void loadSite();
	timer = setInterval(() => {
		if (running.value) void load();
	}, 15_000);
	recheck = setInterval(() => {
		const host = watched.value;
		if (host !== null && !checking.value && document.visibilityState !== 'hidden') {
			void check(host);
		}
	}, 20_000);
});
onBeforeUnmount(() => {
	clearInterval(timer);
	clearInterval(recheck);
});

useHead({ title: () => (site.value ? `Domain for ${site.value.name}` : 'Attach a Domain') });

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
		// the same press would repeat the same attach, so the next one is a new request
		idempotencyKey = crypto.randomUUID();
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { requires?: string } | null;
		if (details?.requires === 'step-up') {
			pending = action;
			needsStepUp.value = true;
		} else {
			error.value = domainRefusalReason(failure);
		}
	} finally {
		busy.value = false;
	}
}

function attach(hostname: string): Promise<void> {
	const org = orgId.value;
	if (org === null) return Promise.resolve();
	return guarded(() => store.attach(org, siteId, { hostname }, idempotencyKey));
}

function cancel(hostname: string): Promise<void> {
	const org = orgId.value;
	if (org === null) return Promise.resolve();
	return guarded(() => store.release(org, siteId, hostname));
}

function stepUpDone(): void {
	needsStepUp.value = false;
	const action = pending;
	pending = null;
	if (action) void guarded(action);
}

const siteMissing = computed(() => siteError.value?.status === 404);
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
				title="Could Not Load the Domain"
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
					<h1 class="text-2xl font-semibold text-highlighted">
						Domain for {{ site.name }}
					</h1>
					<p class="text-sm text-default">
						Visitors keep reaching your site at its Drupflare address while the new
						domain is set up.
					</p>
				</div>

				<UiEmptyState
					v-if="payload && !payload.ready"
					icon="i-lucide-circle-slash"
					title="This Site Cannot Take a Domain"
					text="Only a live managed site can take a domain of its own."
				/>

				<template v-else-if="payload">
					<div
						v-if="payload.attached.length > 0"
						class="flex flex-col gap-1 rounded-lg border border-default p-4"
						data-test="attached"
					>
						<h2 class="text-sm font-semibold text-highlighted">Domains on This Site</h2>
						<ul class="text-sm text-default">
							<li
								v-for="domain in payload.attached"
								:key="domain.hostname"
							>
								{{ domain.hostname }}
							</li>
						</ul>
					</div>

					<template v-if="view">
						<h2 class="text-lg font-semibold text-highlighted">{{ view.hostname }}</h2>
						<SiteDomainStages :view="view" />

						<div
							v-if="waitingForRecord"
							class="flex flex-col gap-3 rounded-lg border border-default p-4"
							data-test="waiting-record"
						>
							<h3 class="text-sm font-semibold text-highlighted">
								{{ WAITING_DNS_TITLE }}
							</h3>
							<p class="text-sm text-default">{{ WAITING_DNS_COPY }}</p>
							<p
								class="text-sm text-default"
								data-test="expires"
							>
								Drupflare stops waiting on {{ expiryDate }}.
							</p>
							<div>
								<UButton
									color="neutral"
									variant="outline"
									:loading="busy"
									:disabled="busy"
									@click="cancel(view.hostname)"
								>
									Cancel This Attach
								</UButton>
							</div>
						</div>

						<p
							v-if="view.reason"
							role="alert"
							class="text-sm text-red-700 dark:text-red-400"
						>
							{{ view.reason }}
						</p>
						<p
							v-else-if="view.status === 'succeeded'"
							class="text-sm text-default"
							data-test="done"
						>
							{{ view.hostname }} is attached. Your site answers on it.
						</p>
						<div
							v-else-if="view.status === 'waiting'"
							class="flex flex-col gap-3"
							data-test="waiting"
						>
							<p class="text-sm text-default">{{ view.notice }}</p>
							<div class="flex flex-wrap gap-2">
								<UButton
									:loading="busy"
									:disabled="busy"
									@click="attach(view.hostname)"
								>
									Try Again
								</UButton>
								<UButton
									color="neutral"
									variant="outline"
									:disabled="busy"
									@click="cancel(view.hostname)"
								>
									Cancel This Attach
								</UButton>
							</div>
						</div>

						<SiteDomainRecords
							v-if="view.status !== 'succeeded' && (shown || view.records.length > 0)"
							:records="shown ? shown.records : view.records"
							:hazards="shown?.hazards"
							:routing-later="shown !== null && !shown.routingKnown"
							:routing-later-text="ROUTING_LATER_COPY"
						/>
					</template>

					<SiteDomainForm
						v-if="showForm"
						:busy="busy"
						:checking="checking"
						:error="error"
						@attach="attach"
						@check="check"
					/>

					<SiteDomainRecords
						v-if="showForm && shown && !(view && view.status !== 'succeeded')"
						:records="shown.records"
						:hazards="shown.hazards"
						:routing-later="!shown.routingKnown"
						:routing-later-text="ROUTING_LATER_COPY"
					/>

					<p
						v-if="error && !showForm"
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
			</template>
		</div>
		<template #fallback>
			<SiteSkeleton />
		</template>
	</ClientOnly>
</template>
