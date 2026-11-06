<script setup lang="ts">
import type { ApiClientError } from '~/composables/useApi';
import { toApiClientError, useApi } from '~/composables/useApi';
import { adminUrlFor } from '~/composables/useOnboarding';
import { useOperation } from '~/composables/useOperation';
import type { SiteSummary } from '~/stores/sites';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Creating a Site' });

const route = useRoute();
const router = useRouter();
const org = useOrgStore();
const opId = String(route.params.op);
const orgId = computed(() => org.current?.id ?? null);

const { operation, error, missing, refresh } = useOperation(orgId, opId);

const succeeded = computed(() => operation.value?.status === 'succeeded');
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
const siteId = computed(() => (succeeded.value ? (operation.value?.targetIds[0] ?? null) : null));

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
		failedStep.value?.error ??
		operation.value?.finalObservation?.summary ??
		'The server did not give a reason.'
);

const rollbackText = computed(() =>
	operation.value?.status === 'rolled-back'
		? 'Changes made before the failure were rolled back.'
		: 'No rollback is recorded for this operation.'
);

const adminUrl = computed(() => (site.value ? adminUrlFor(site.value) : null));

function startOver(): void {
	void router.push('/new');
}
</script>

<template>
	<ClientOnly>
		<div class="flex max-w-3xl flex-col gap-6">
			<h1 class="text-2xl font-semibold text-highlighted">Creating Your Site</h1>

			<UiErrorState
				v-if="missing"
				title="Operation Not Found"
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
				title="Could Not Load the Operation"
				text="Check your connection and try again."
				:request-id="error.requestId"
			>
				<UButton
					color="neutral"
					@click="refresh()"
				>
					Try Again
				</UButton>
			</UiErrorState>

			<p
				v-else-if="!operation"
				role="status"
				class="text-sm text-muted"
			>
				Loading the operation...
			</p>

			<template v-else>
				<div class="flex flex-wrap items-center gap-3">
					<OpBadge :status="operation.status" />
					<p
						v-if="runningStep"
						role="status"
						class="text-sm text-muted"
					>
						Now: {{ runningStep.name }}
					</p>
				</div>

				<OpTimeline :steps="operation.steps" />

				<UiErrorState
					v-if="failed"
					title="Could Not Create the Site"
					:text="reason"
				>
					<div class="flex flex-col gap-2 text-sm text-muted">
						<p v-if="failedStep">Failed step: {{ failedStep.name }}</p>
						<p>{{ rollbackText }}</p>
					</div>
					<UButton
						color="neutral"
						@click="startOver"
					>
						Try Again
					</UButton>
				</UiErrorState>

				<section
					v-else-if="succeeded"
					class="flex flex-col gap-6 rounded-lg border border-default p-6"
				>
					<h2 class="text-lg font-semibold text-highlighted">Your Site</h2>

					<UiErrorState
						v-if="siteError"
						title="Could Not Load the Site"
						text="Check your connection and try again."
						:request-id="siteError.requestId"
					>
						<UButton
							color="neutral"
							@click="siteId && loadSite(siteId)"
						>
							Try Again
						</UButton>
					</UiErrorState>

					<p
						v-else-if="!site"
						role="status"
						class="text-sm text-muted"
					>
						Loading the site address...
					</p>

					<template v-else>
						<p class="wrap-break-word">
							<a
								:href="`https://${site.primaryHostname}`"
								class="font-medium text-brand-700 underline dark:text-brand-300"
								>{{ site.primaryHostname }}</a
							>
						</p>

						<div class="flex flex-col gap-2">
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
			<p
				role="status"
				class="text-sm text-muted"
			>
				Loading the operation...
			</p>
		</template>
	</ClientOnly>
</template>
