<script setup lang="ts">
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import {
	STEP_TITLES,
	kindFor,
	nameProblem,
	useOnboarding,
	type OnboardingStep
} from '~/composables/useOnboarding';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Create a Site' });

interface Template {
	id: string;
	name: string;
	category: 'cms' | 'workers' | null;
	free: boolean;
	enabled: boolean;
	comingSoon: string | null;
}

const org = useOrgStore();
const router = useRouter();
const { draft, go, create } = useOnboarding();

const orgId = computed(() => org.current?.id ?? null);
const step = computed<OnboardingStep>(() => draft.value.step);

const paidAllowed = computed(() => org.currentPlan?.features.customCode);
const templates = ref<Template[] | null>(null);
const templatesError = ref<ApiClientError | null>(null);

async function loadTemplates(): Promise<void> {
	templatesError.value = null;
	try {
		const page = await useApi().get<{ items: Template[] }>('/templates');
		templates.value = page.items;
	} catch (error) {
		templatesError.value = toApiClientError(error);
	}
}

const heading = ref<HTMLElement | null>(null);
// focus moves to the step heading on each change, not on first load
watch(step, async () => {
	await nextTick();
	heading.value?.focus();
});

const touched = ref(false);
const creating = ref(false);
const createError = ref<ApiClientError | null>(null);
const problem = computed(() => nameProblem(draft.value.name));
const nameError = computed(() => (touched.value ? problem.value : null));
const canNext = computed(() => kindFor(draft.value.template) !== null);

async function submit(): Promise<void> {
	touched.value = true;
	if (creating.value || problem.value !== null || orgId.value === null) return;
	const kind = kindFor(draft.value.template);
	if (kind === null) return;
	creating.value = true;
	createError.value = null;
	try {
		const operation = await create(orgId.value, kind);
		await router.push(`/new/progress/${operation.id}`);
	} catch (error) {
		createError.value = toApiClientError(error);
	} finally {
		creating.value = false;
	}
}

watch(orgId, (id) => {
	if (id !== null) void org.loadPlan(id);
});

onMounted(() => {
	void loadTemplates();
	if (orgId.value !== null) void org.loadPlan(orgId.value);
});
</script>

<template>
	<ClientOnly>
		<div class="flex max-w-3xl flex-col gap-6">
			<UiPageHeader
				title="Create a Site"
				text="Each step has a default, so you can skip any of them."
			/>

			<OnboardingStepper :step="step" />

			<section class="flex flex-col gap-6 rounded-lg border border-default p-6">
				<h2
					ref="heading"
					tabindex="-1"
					class="text-lg font-semibold text-highlighted focus:outline-none"
				>
					{{ STEP_TITLES[step] }}
				</h2>

				<template v-if="step === 1">
					<OnboardingWherePicker />
					<div class="flex flex-wrap justify-end gap-3">
						<UButton
							color="neutral"
							variant="outline"
							@click="go(2)"
						>
							Skip
						</UButton>
						<UButton
							color="primary"
							variant="solid"
							@click="go(2)"
						>
							Next
						</UButton>
					</div>
				</template>

				<template v-else-if="step === 2">
					<div
						v-if="templates === null && templatesError === null"
						role="status"
					>
						<span class="sr-only">Loading templates</span>
						<div
							aria-hidden="true"
							class="flex flex-col gap-6"
						>
							<div
								v-for="group in 2"
								:key="group"
								class="flex flex-col gap-3"
							>
								<USkeleton class="h-5 w-20" />
								<USkeleton
									v-for="card in 2"
									:key="card"
									class="h-16 w-full"
								/>
							</div>
						</div>
					</div>
					<UiErrorState
						v-else-if="templatesError !== null"
						title="Could Not Load Templates"
						:text="templatesError.message"
						:request-id="templatesError.requestId"
					>
						<UButton
							color="neutral"
							@click="loadTemplates()"
						>
							Try Again
						</UButton>
					</UiErrorState>
					<OnboardingWhatGrid
						v-else-if="templates !== null"
						v-model="draft.template"
						:templates="templates"
						:paid-allowed="paidAllowed"
					/>

					<div class="flex flex-wrap justify-between gap-3">
						<UButton
							color="neutral"
							variant="outline"
							@click="go(1)"
						>
							Back
						</UButton>
						<div class="flex flex-wrap gap-3">
							<UButton
								color="neutral"
								variant="outline"
								@click="go(3)"
							>
								Skip
							</UButton>
							<UButton
								color="primary"
								variant="solid"
								:disabled="!canNext"
								@click="go(3)"
							>
								Next
							</UButton>
						</div>
					</div>
				</template>

				<form
					v-else
					class="flex flex-col gap-6"
					@submit.prevent="submit"
				>
					<OnboardingNameField
						v-model="draft.name"
						:error="nameError"
						@blur="touched = true"
					/>

					<p
						v-if="createError"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ createError.message }}
					</p>

					<div class="flex flex-wrap justify-between gap-3">
						<UButton
							color="neutral"
							variant="outline"
							@click="go(2)"
						>
							Back
						</UButton>
						<UButton
							type="submit"
							color="primary"
							variant="solid"
							:loading="creating"
							:disabled="creating"
						>
							Create
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
					<USkeleton class="h-6 w-64 max-w-full" />
					<div class="flex flex-col gap-6 rounded-lg border border-default p-6">
						<USkeleton class="h-7 w-24" />
						<USkeleton class="h-16 w-full" />
						<USkeleton class="h-16 w-full" />
					</div>
				</div>
			</div>
		</template>
	</ClientOnly>
</template>
