<script setup lang="ts">
import { ESTATE_LIMITS } from '@contracts/estate';
import { toApiClientError } from '~/composables/useApi';
import type { AssessmentView, CheckView } from '~/shared/estate-view';
import { useEstateStore } from '~/stores/estate';
import { useOrgStore } from '~/stores/org';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Assess an Estate' });

const router = useRouter();
const org = useOrgStore();
const estate = useEstateStore();
const orgId = computed(() => org.current?.id ?? null);

const text = ref('');
const fileName = ref<string | null>(null);
const fileError = ref<string | null>(null);

const checking = ref(false);
const checkError = ref<string | null>(null);
// the result is for the text it was made from; any edit clears it
const check = ref<CheckView | null>(null);
watch(text, () => {
	check.value = null;
	checkError.value = null;
});

const starting = ref(false);
const startError = ref<string | null>(null);
// a retry after a lost response reuses the key so the assessment is not doubled
const startKey = ref(crypto.randomUUID());

const listed = ref<AssessmentView[]>([]);
const listCursor = ref<string | null>(null);
const listLoaded = ref(false);
const listLoading = ref(false);
const listError = ref<string | null>(null);

async function loadList(reset: boolean): Promise<void> {
	const id = orgId.value;
	if (id === null || listLoading.value) return;
	listLoading.value = true;
	listError.value = null;
	try {
		const page = await estate.list(id, reset ? undefined : (listCursor.value ?? undefined));
		listed.value = reset ? page.items : [...listed.value, ...page.items];
		listCursor.value = page.nextCursor;
		listLoaded.value = true;
	} catch (error) {
		listError.value = toApiClientError(error).message;
	} finally {
		listLoading.value = false;
	}
}

onMounted(() => {
	void loadList(true);
});

const sizeProblem = computed(() => {
	if (text.value.trim() === '') return 'Add an inventory before you check it.';
	if (new TextEncoder().encode(text.value).length > ESTATE_LIMITS.textBytes) {
		return 'The inventory is larger than 1 MiB. Split it into smaller files.';
	}
	return null;
});

const canStart = computed(
	() =>
		check.value !== null &&
		check.value.fileError === null &&
		check.value.sites > 0 &&
		!starting.value
);

async function chooseFile(event: Event): Promise<void> {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	if (!file) return;
	fileError.value = null;
	try {
		text.value = await file.text();
		fileName.value = file.name;
	} catch {
		fileError.value = 'The file could not be read. Choose it again or paste the text.';
	}
}

async function runCheck(): Promise<void> {
	const id = orgId.value;
	if (id === null || checking.value) return;
	const problem = sizeProblem.value;
	if (problem !== null) {
		checkError.value = problem;
		return;
	}
	checking.value = true;
	checkError.value = null;
	try {
		check.value = await estate.check(id, text.value);
	} catch (error) {
		checkError.value = toApiClientError(error).message;
	} finally {
		checking.value = false;
	}
}

async function startAssessment(): Promise<void> {
	const id = orgId.value;
	if (id === null || !canStart.value) return;
	starting.value = true;
	startError.value = null;
	try {
		const view = await estate.start(id, { text: text.value }, startKey.value);
		await router.push(`/assess/estate/${encodeURIComponent(view.id)}`);
	} catch (error) {
		const failure = toApiClientError(error);
		startError.value = failure.message;
		if (failure.status !== 0) startKey.value = crypto.randomUUID();
	} finally {
		starting.value = false;
	}
}
</script>

<template>
	<ClientOnly>
		<div class="flex max-w-3xl flex-col gap-6">
			<UiPageHeader
				title="Assess an Estate"
				text="Check a list of Drupal sites before you move them. Each site is read, and nothing on it is changed."
			/>

			<section class="flex flex-col gap-4">
				<h2 class="text-lg font-semibold text-highlighted">Past Assessments</h2>
				<AssessEstateList
					:items="listed"
					:next-cursor="listCursor"
					:loaded="listLoaded"
					:loading="listLoading"
					:error="listError"
					@more="loadList(false)"
				/>
			</section>

			<section class="flex flex-col gap-6 rounded-lg border border-default p-6">
				<h2 class="text-lg font-semibold text-highlighted">Inventory</h2>

				<AssessEstateFormat />

				<UiField
					id="estate-file"
					label="Inventory File"
					hint="Pick a CSV or JSON file. Its text fills the box below."
					:error="fileError"
				>
					<template #default="{ describedBy }">
						<input
							id="estate-file"
							type="file"
							accept=".csv,.json,text/csv,application/json"
							:aria-describedby="describedBy"
							class="w-full text-sm text-default file:mr-3 file:rounded-md file:border file:border-default file:bg-default file:px-3 file:py-2"
							@change="chooseFile"
						/>
					</template>
				</UiField>
				<p
					v-if="fileName"
					class="text-sm text-muted"
				>
					Loaded {{ fileName }}.
				</p>

				<UiField
					id="estate-text"
					label="Inventory Text"
					hint="Paste the rows here, or edit the text from the file."
				>
					<template #default="{ describedBy }">
						<textarea
							id="estate-text"
							v-model="text"
							rows="10"
							spellcheck="false"
							:aria-describedby="describedBy"
							class="w-full rounded-md border border-default bg-default px-3 py-2 font-mono text-sm text-default focus-visible:ring-2 focus-visible:ring-primary"
						/>
					</template>
				</UiField>

				<p
					v-if="checkError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ checkError }}
				</p>

				<div>
					<UButton
						color="neutral"
						variant="outline"
						:loading="checking"
						:disabled="checking"
						@click="runCheck()"
					>
						Check the Inventory
					</UButton>
				</div>
			</section>

			<section
				v-if="check"
				class="flex flex-col gap-6 rounded-lg border border-default p-6"
			>
				<h2 class="text-lg font-semibold text-highlighted">Check Results</h2>

				<AssessEstateCheck :check="check" />

				<p
					v-if="startError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ startError }}
				</p>

				<div>
					<UButton
						color="primary"
						variant="solid"
						:loading="starting"
						:disabled="!canStart"
						@click="startAssessment()"
					>
						Start the Assessment
					</UButton>
				</div>
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
