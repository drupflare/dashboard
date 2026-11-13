<script setup lang="ts">
import type { Operation } from '@contracts/operations';
import { ApiClientError, toApiClientError } from '~/composables/useApi';
import { nameProblem } from '~/composables/useOnboarding';
import { usePoll } from '~/composables/usePoll';
import { suggest } from '~/shared/names';
import {
	failedStepError,
	failedStepId,
	failureReason,
	importRefusalReason
} from '~/shared/operation-copy';
import { useImportsStore } from '~/stores/imports';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Import From a Server' });

const TITLES = ['Add the Server', 'Confirm the Host Key', 'Check the Server', 'Name and Start'];
const TERMINAL: ReadonlySet<Operation['status']> = new Set([
	'succeeded',
	'failed',
	'cancelled',
	'rolled-back'
]);
const FAILED: ReadonlySet<Operation['status']> = new Set(['failed', 'cancelled', 'rolled-back']);

const router = useRouter();
const org = useOrgStore();
const imports = useImportsStore();
const orgId = computed(() => org.current?.id ?? null);

const step = ref(1);
const heading = ref<HTMLElement | null>(null);
// focus moves to the step heading on each change, not on first load
watch(step, async () => {
	await nextTick();
	heading.value?.focus();
});

const host = ref('');
const port = ref('22');
const username = ref('');
const root = ref('');

const creating = ref(false);
const createError = ref<ApiClientError | null>(null);

async function makeKey(values: { host: string; port: number; username: string }): Promise<void> {
	const id = orgId.value;
	if (id === null || creating.value) return;
	creating.value = true;
	createError.value = null;
	try {
		await imports.createCredential(id, {
			host: values.host,
			port: values.port,
			username: values.username
		});
	} catch (error) {
		createError.value = toApiClientError(error);
	} finally {
		creating.value = false;
	}
}

const surveyOp = ref<Operation | null>(null);
const surveyError = ref<ApiClientError | null>(null);
const starting = ref(false);
const survey = computed(() =>
	surveyOp.value === null ? null : (imports.surveys.get(surveyOp.value.id) ?? null)
);
const surveyFailed = computed(() => surveyOp.value !== null && FAILED.has(surveyOp.value.status));
const surveyFinished = computed(
	() => surveyOp.value !== null && TERMINAL.has(surveyOp.value.status)
);
const surveyFailure = computed(() => {
	const op = surveyOp.value;
	if (op === null) return '';
	return (
		failureReason({
			type: op.type,
			status: op.status,
			failedStep: failedStepId(op.steps),
			failedError: failedStepError(op.steps)
		}) ?? ''
	);
});
const surveyErrorText = computed(() =>
	surveyError.value === null ? '' : importRefusalReason(surveyError.value)
);

const pollSurvey = usePoll(async () => {
	const id = orgId.value;
	const operationId = surveyOp.value?.id;
	if (id === null || operationId === undefined) return;
	try {
		const next = await imports.readSurvey(id, operationId);
		if (next === null) {
			surveyError.value = new ApiClientError(
				'not_found',
				'The check could not be found. Start it again.',
				404,
				null,
				null
			);
			pollSurvey.stop();
			return;
		}
		surveyOp.value = next;
		if (TERMINAL.has(next.status)) pollSurvey.stop();
	} catch (error) {
		surveyError.value = toApiClientError(error);
		pollSurvey.stop();
	}
});

async function startSurvey(): Promise<void> {
	const id = orgId.value;
	const credential = imports.credential;
	if (id === null || credential === null || starting.value) return;
	starting.value = true;
	surveyError.value = null;
	surveyOp.value = null;
	try {
		surveyOp.value = await imports.startSurvey(
			id,
			credential.id,
			root.value,
			crypto.randomUUID()
		);
		pollSurvey.start();
	} catch (error) {
		surveyError.value = toApiClientError(error);
	} finally {
		starting.value = false;
	}
}

// a check that is still running resumes; a failed or missing one starts again
function tryAgainSurvey(): void {
	if (surveyOp.value !== null && !surveyFinished.value) pollSurvey.start();
	else void startSurvey();
}

function confirmedHostKey(): void {
	step.value = 3;
	void startSurvey();
}

function restart(): void {
	pollSurvey.stop();
	imports.reset();
	surveyOp.value = null;
	surveyError.value = null;
	step.value = 1;
}

const name = ref(suggest(crypto.randomUUID()));
const nameTouched = ref(false);
const nameError = computed(() => (nameTouched.value ? nameProblem(name.value) : null));
const startError = ref<ApiClientError | null>(null);
const startText = computed(() =>
	startError.value === null ? '' : importRefusalReason(startError.value)
);
// a retry after a lost response reuses the key so the import is not doubled
const importKey = ref(crypto.randomUUID());
const importing = ref(false);

async function startImport(): Promise<void> {
	nameTouched.value = true;
	const id = orgId.value;
	const credential = imports.credential;
	const check = surveyOp.value;
	if (importing.value || id === null || credential === null || check === null) return;
	if (nameProblem(name.value) !== null) return;
	importing.value = true;
	startError.value = null;
	try {
		const op = await imports.startImport(
			id,
			{ credentialId: credential.id, surveyId: check.id, name: name.value },
			importKey.value
		);
		await router.push(`/new/progress/${encodeURIComponent(op.id)}`);
	} catch (error) {
		startError.value = toApiClientError(error);
		if (startError.value.status !== 0) importKey.value = crypto.randomUUID();
	} finally {
		importing.value = false;
	}
}
</script>

<template>
	<ClientOnly>
		<div class="flex max-w-3xl flex-col gap-6">
			<UiPageHeader
				title="Import From a Server"
				text="Copy a Drupal site from a Linux server you own into a new site. The site on your server keeps running while the copy is made."
			/>

			<OnboardingStepper
				:step="step"
				:titles="TITLES"
			/>

			<section class="flex flex-col gap-6 rounded-lg border border-default p-6">
				<h2
					ref="heading"
					tabindex="-1"
					class="text-lg font-semibold text-highlighted focus:outline-none"
				>
					{{ TITLES[step - 1] }}
				</h2>

				<OnboardingImportSshForm
					v-if="step === 1"
					v-model:host="host"
					v-model:port="port"
					v-model:username="username"
					v-model:root="root"
					:credential="imports.credential"
					:busy="creating"
					:error="createError ? importRefusalReason(createError) : null"
					@submit="makeKey"
					@next="step = 2"
				/>

				<template v-else-if="step === 2 && imports.credential !== null">
					<OnboardingImportHostKey
						:org-id="orgId ?? ''"
						:credential-id="imports.credential.id"
						@confirmed="confirmedHostKey()"
						@back="step = 1"
						@restart="restart()"
					/>
				</template>

				<template v-else-if="step === 3">
					<UiErrorState
						v-if="surveyError"
						title="Could Not Check the Server"
						:text="surveyErrorText"
						:request-id="surveyError.requestId"
					>
						<div class="flex flex-wrap gap-3">
							<UButton
								color="neutral"
								@click="tryAgainSurvey()"
							>
								Try Again
							</UButton>
							<UButton
								color="neutral"
								variant="outline"
								@click="step = 2"
							>
								Back
							</UButton>
						</div>
					</UiErrorState>

					<UiErrorState
						v-else-if="surveyFailed"
						title="Could Not Check the Server"
						:text="surveyFailure"
					>
						<div class="flex flex-wrap gap-3">
							<UButton
								color="neutral"
								@click="tryAgainSurvey()"
							>
								Try Again
							</UButton>
							<UButton
								color="neutral"
								variant="outline"
								@click="step = 2"
							>
								Back
							</UButton>
						</div>
					</UiErrorState>

					<OnboardingImportDossier
						v-else-if="survey"
						:dossier="survey.dossier"
						@next="step = 4"
					/>

					<div
						v-else
						role="status"
						class="flex flex-col gap-3"
					>
						<span class="text-sm text-muted">
							Reading your server. Nothing on it is changed.
						</span>
						<USkeleton
							class="h-5 w-64 max-w-full"
							aria-hidden="true"
						/>
						<USkeleton
							class="h-16 w-full"
							aria-hidden="true"
						/>
					</div>
				</template>

				<form
					v-else-if="step === 4"
					class="flex flex-col gap-6"
					@submit.prevent="startImport"
				>
					<OnboardingNameField
						v-model="name"
						:error="nameError"
						@blur="nameTouched = true"
					/>

					<p
						v-if="startError"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ startText }}
					</p>

					<div class="flex flex-wrap justify-between gap-3">
						<UButton
							color="neutral"
							variant="outline"
							@click="step = 3"
						>
							Back
						</UButton>
						<UButton
							type="submit"
							color="primary"
							variant="solid"
							:loading="importing"
							:disabled="importing"
						>
							Start Import
						</UButton>
					</div>
				</form>
			</section>
		</div>
		<template #fallback>
			<div role="status">
				<span class="sr-only">Loading the page</span>
				<div
					aria-hidden="true"
					class="flex max-w-3xl flex-col gap-6"
				>
					<div class="flex flex-col gap-2">
						<USkeleton class="h-9 w-48" />
						<USkeleton class="h-5 w-72 max-w-full" />
					</div>
					<div class="flex flex-col gap-6 rounded-lg border border-default p-6">
						<USkeleton class="h-7 w-24" />
						<USkeleton class="h-16 w-full" />
					</div>
				</div>
			</div>
		</template>
	</ClientOnly>
</template>
