<script setup lang="ts">
import type { Operation } from '@contracts/operations';
import type { ApiClientError } from '~/composables/useApi';
import { toApiClientError, useApi } from '~/composables/useApi';
import { adminUrlFor } from '~/composables/useOnboarding';
import { useOperation } from '~/composables/useOperation';
import { usePoll } from '~/composables/usePoll';
import {
	canRetry,
	copyFor,
	failedStepError,
	failedStepId,
	failureReason,
	LARGER_RESTORE_TITLE,
	needsLargerRestore,
	refusalReason,
	stepLabel
} from '~/shared/operation-copy';
import { useOperationsStore } from '~/stores/operations';
import { type SiteSummary, useSitesStore } from '~/stores/sites';

// a retry opens a new operation on the same route, so the page remounts per operation id
definePageMeta({ middleware: ['auth', 'org'], key: (route) => route.fullPath });

const route = useRoute();
const router = useRouter();
const org = useOrgStore();
const opId = String(route.params.op);
const orgId = computed(() => org.current?.id ?? null);

const { operation, error, missing, refresh } = useOperation(orgId, opId);

const copy = computed(() => copyFor(operation.value?.type));
useHead({ title: () => copy.value.title });

const succeeded = computed(() => operation.value?.status === 'succeeded');
// only a create has a new site to show, its address and its first admin password
const showsSite = computed(() => operation.value?.type === 'site.create');
const running = computed(() => {
	const status = operation.value?.status;
	return status === 'planned' || status === 'running' || status === 'verifying';
});
const failed = computed(() => {
	const status = operation.value?.status;
	return status === 'failed' || status === 'cancelled' || status === 'rolled-back';
});
const runningStep = computed(
	() => operation.value?.steps.find((step) => step.state === 'running') ?? null
);
const failedStep = computed(
	() => operation.value?.steps.find((step) => step.state === 'failed') ?? null
);
const siteId = computed(() =>
	succeeded.value && showsSite.value ? (operation.value?.targetIds[0] ?? null) : null
);

const site = ref<SiteSummary | null>(null);
const siteError = ref<ApiClientError | null>(null);

async function loadSite(id: string): Promise<void> {
	siteError.value = null;
	try {
		site.value = await useApi().get<SiteSummary>(`/sites/${encodeURIComponent(id)}`);
	} catch (failure) {
		siteError.value = toApiClientError(failure);
	}
}

watch(
	siteId,
	(id) => {
		if (id !== null && site.value === null) void loadSite(id);
	},
	{ immediate: true }
);

const reason = computed(
	() =>
		failureReason({
			type: operation.value?.type,
			status: operation.value?.status ?? '',
			failedStep: failedStepId(operation.value?.steps ?? []),
			failedError: failedStepError(operation.value?.steps ?? [])
		}) ?? ''
);

const failureTitle = computed(() =>
	needsLargerRestore({
		type: operation.value?.type,
		failedStep: failedStepId(operation.value?.steps ?? []),
		failedError: failedStepError(operation.value?.steps ?? [])
	})
		? LARGER_RESTORE_TITLE
		: copy.value.failure
);

const rollbackText = computed(() => {
	if (operation.value?.type === 'site.delete') {
		return 'The delete stopped part way. Deleting the site again finishes it.';
	}
	if (operation.value?.type === 'site.adopt') {
		return 'Your original site was not changed. Whatever the adoption made was removed.';
	}
	return operation.value?.status === 'rolled-back'
		? 'Changes made before the failure were rolled back.'
		: 'No rollback is recorded for this activity.';
});

const adminUrl = computed(() => (site.value ? adminUrlFor(site.value) : null));

const failureLink = computed(() =>
	operation.value ? copy.value.failureLink(operation.value) : null
);
const successLink = computed(() => (operation.value ? copy.value.link(operation.value) : null));

function followFailureLink(): void {
	if (failureLink.value) void router.push(failureLink.value.to);
}

const operations = useOperationsStore();
const sites = useSitesStore();
const actionError = ref<string | null>(null);
const retrying = ref(false);
const removing = ref(false);
const retryable = computed(() => canRetry(operation.value?.type, operation.value?.status ?? ''));
// a create that failed leaves a half-made site behind; only the create has that attempt to remove
const attemptFailed = computed(
	() =>
		showsSite.value &&
		(operation.value?.status === 'failed' || operation.value?.status === 'rolled-back')
);

const cleanupOp = ref<Operation | null>(null);
const cleanupRunning = computed(() => {
	const status = cleanupOp.value?.status;
	return status === 'planned' || status === 'running' || status === 'verifying';
});
// a cleanup of a site that is already gone answers with the create it was cleaning up
const attemptRemoved = computed(
	() =>
		cleanupOp.value !== null &&
		(cleanupOp.value.status === 'succeeded' || cleanupOp.value.type !== 'repair.run')
);

const cleanupReason = computed(() =>
	cleanupOp.value && !attemptRemoved.value
		? failureReason({
				type: cleanupOp.value.type,
				status: cleanupOp.value.status,
				failedStep: failedStepId(cleanupOp.value.steps)
			})
		: null
);

const cleanupPoll = usePoll(async () => {
	const org = orgId.value;
	const id = cleanupOp.value?.id;
	if (!org || !id) return;
	const next = await operations.fetchOne(org, id);
	if (next === null) {
		cleanupPoll.stop();
		return;
	}
	cleanupOp.value = next;
	if (!['planned', 'running', 'verifying'].includes(next.status)) cleanupPoll.stop();
});

async function tryAgain(): Promise<void> {
	const org = orgId.value;
	if (!org) return;
	actionError.value = null;
	retrying.value = true;
	try {
		const next = await operations.retry(org, opId);
		await router.push(`/new/progress/${encodeURIComponent(next.id)}`);
	} catch (failure) {
		actionError.value = refusalReason(toApiClientError(failure));
	} finally {
		retrying.value = false;
	}
}

async function removeAttempt(): Promise<void> {
	const org = orgId.value;
	const hidden = operation.value?.targetIds[0];
	if (!org || !hidden) return;
	actionError.value = null;
	removing.value = true;
	try {
		cleanupOp.value = await sites.cleanup(org, hidden);
		cleanupPoll.start();
	} catch (failure) {
		actionError.value = refusalReason(toApiClientError(failure));
	} finally {
		removing.value = false;
	}
}
</script>

<template>
	<ClientOnly>
		<div class="flex max-w-3xl flex-col gap-6">
			<h1 class="text-2xl font-semibold text-highlighted">{{ copy.title }}</h1>

			<UiErrorState
				v-if="missing"
				title="Activity Not Found"
				text="Check the link, or start a new site."
			>
				<UButton
					color="neutral"
					to="/new"
				>
					Create a Site
				</UButton>
			</UiErrorState>

			<UiErrorState
				v-else-if="error && !operation"
				title="Could Not Load the Activity"
				:text="error.message"
				:request-id="error.requestId"
			>
				<UButton
					color="neutral"
					@click="refresh()"
				>
					Try Again
				</UButton>
			</UiErrorState>

			<OpSkeleton v-else-if="!operation" />

			<template v-else>
				<div class="flex flex-wrap items-center gap-3">
					<OpBadge :status="operation.status" />
					<p
						v-if="runningStep"
						role="status"
						class="text-sm text-muted"
					>
						Now: {{ stepLabel(operation.type, runningStep.id) }}
					</p>
				</div>

				<p
					v-if="running"
					class="text-sm text-muted"
				>
					{{ copy.running }}
				</p>

				<OpTimeline
					:steps="operation.steps"
					:type="operation.type"
				/>

				<UiErrorState
					v-if="failed"
					:title="failureTitle"
					:text="reason"
				>
					<div class="flex flex-col gap-2 text-sm text-muted">
						<p v-if="failedStep">
							Failed step: {{ stepLabel(operation.type, failedStep.id) }}
						</p>
						<p>{{ rollbackText }}</p>
					</div>
					<div class="flex flex-wrap gap-3">
						<UButton
							v-if="retryable"
							color="neutral"
							:loading="retrying"
							@click="tryAgain"
						>
							Try Again
						</UButton>
						<UButton
							v-if="failureLink"
							color="neutral"
							@click="followFailureLink"
						>
							{{ failureLink.label }}
						</UButton>
						<UButton
							v-if="attemptFailed && !attemptRemoved && !cleanupRunning"
							color="neutral"
							variant="outline"
							:loading="removing"
							@click="removeAttempt"
						>
							Remove This Attempt
						</UButton>
						<UButton
							v-if="attemptRemoved"
							color="primary"
							to="/new"
						>
							Start Over
						</UButton>
					</div>
					<p
						v-if="cleanupRunning"
						role="status"
						class="text-sm text-muted"
					>
						Removing the first attempt. Leaving this page does not stop it.
					</p>
					<p
						v-if="actionError || cleanupReason"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ actionError ?? cleanupReason }}
					</p>
				</UiErrorState>

				<section
					v-else-if="succeeded && !showsSite"
					class="flex flex-col items-start gap-4 rounded-lg border border-default p-6"
				>
					<p
						role="status"
						class="text-base font-medium text-highlighted"
					>
						{{ copy.success }}
					</p>
					<UButton
						v-if="successLink"
						:to="successLink.to"
						color="primary"
						>{{ successLink.label }}</UButton
					>
				</section>

				<section
					v-else-if="succeeded"
					class="flex flex-col gap-6 rounded-lg border border-default p-6"
				>
					<h2 class="text-lg font-semibold text-highlighted">Your Site</h2>

					<UiErrorState
						v-if="siteError"
						title="Could Not Load the Site"
						:text="siteError.message"
						:request-id="siteError.requestId"
					>
						<UButton
							color="neutral"
							@click="siteId && loadSite(siteId)"
						>
							Try Again
						</UButton>
					</UiErrorState>

					<div
						v-else-if="!site"
						role="status"
						class="flex flex-col gap-3"
					>
						<span class="sr-only">Loading the site address</span>
						<USkeleton
							class="h-5 w-64 max-w-full"
							aria-hidden="true"
						/>
						<USkeleton
							class="h-9 w-40"
							aria-hidden="true"
						/>
					</div>

					<template v-else>
						<p class="wrap-break-word">
							<a
								:href="`https://${site.primaryHostname}`"
								class="font-medium text-brand-700 underline dark:text-brand-300"
								>{{ site.primaryHostname }}</a
							>
						</p>

						<div class="flex flex-col gap-2">
							<p
								v-if="site.admin.username"
								class="text-sm"
							>
								<span class="text-muted">Username</span>
								<code class="ml-2 text-highlighted select-all">{{
									site.admin.username
								}}</code>
							</p>
							<h3 class="text-base font-semibold text-highlighted">Admin Password</h3>
							<UiSecretOnce
								v-if="orgId"
								:org-id="orgId"
								:site-id="site.id"
							/>
						</div>

						<div v-if="adminUrl">
							<UButton
								color="primary"
								variant="solid"
								icon="i-lucide-external-link"
								:href="adminUrl"
								target="_blank"
								rel="noopener"
							>
								Open Admin
							</UButton>
						</div>
					</template>
				</section>
			</template>
		</div>
		<template #fallback>
			<OpSkeleton />
		</template>
	</ClientOnly>
</template>
