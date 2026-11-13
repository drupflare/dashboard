<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { usePoll } from '~/composables/usePoll';
import type { AssessmentView, ProofCheck, ProofView, RowView } from '~/shared/estate-view';
import { useEstateStore } from '~/stores/estate';
import { useOrgStore } from '~/stores/org';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Estate Assessment' });

const route = useRoute();
const assessmentId = String(route.params.id);
const org = useOrgStore();
const estate = useEstateStore();
const orgId = computed(() => org.current?.id ?? null);

const TERMINAL: ReadonlySet<AssessmentView['state']> = new Set(['finished', 'cancelled', 'failed']);

const view = ref<AssessmentView | null>(null);
const missing = ref(false);
const loadError = ref<string | null>(null);
const finished = computed(() => view.value !== null && TERMINAL.has(view.value.state));

const rows = ref<RowView[]>([]);
const rowsCursor = ref<string | null>(null);
const rowsLoading = ref(false);
const rowsError = ref<string | null>(null);
// a filter change made during a load; the next load reads it once the current one ends
const rowsStale = ref(false);
const rowFilter = ref({ class: '', state: '', q: '' });

const exporting = ref(false);
const exportError = ref<string | null>(null);
const cancelling = ref(false);
const cancelError = ref<string | null>(null);

const proofHost = ref<string | null>(null);
const proofView = ref<ProofView | null>(null);
const proofLoading = ref(false);
const proofError = ref<string | null>(null);
const proofMethod = ref<'dns' | 'http'>('dns');
const proofCheck = ref<ProofCheck | null>(null);
const proofChecking = ref(false);
const proofCheckError = ref<string | null>(null);

// the report reads the same counts as the progress line, so it follows the poll and needs no extra read
const poll = usePoll(loadView);

async function loadView(): Promise<void> {
	const id = orgId.value;
	if (id === null) return;
	try {
		const next = await estate.read(id, assessmentId);
		if (next === null) {
			missing.value = true;
			poll.stop();
			return;
		}
		const previous = view.value?.state;
		view.value = next;
		loadError.value = null;
		if (finished.value) poll.stop();
		// the rows are final once the run ends, so they load again
		if (previous !== undefined && previous !== next.state && finished.value) {
			void loadRows(true);
		}
	} catch (error) {
		loadError.value = toApiClientError(error).message;
		poll.stop();
	}
}

async function loadRows(reset: boolean): Promise<void> {
	const id = orgId.value;
	if (id === null) return;
	if (rowsLoading.value) {
		if (reset) rowsStale.value = true;
		return;
	}
	rowsLoading.value = true;
	rowsError.value = null;
	try {
		const page = await estate.readRows(id, assessmentId, {
			...rowFilter.value,
			cursor: reset ? undefined : (rowsCursor.value ?? undefined)
		});
		rows.value = reset ? page.items : [...rows.value, ...page.items];
		rowsCursor.value = page.nextCursor;
	} catch (error) {
		rowsError.value = toApiClientError(error).message;
	} finally {
		rowsLoading.value = false;
		if (rowsStale.value) {
			rowsStale.value = false;
			void loadRows(true);
		}
	}
}

function applyFilter(filter: typeof rowFilter.value): void {
	rowFilter.value = filter;
	void loadRows(true);
}

async function openProof(hostname: string): Promise<void> {
	const id = orgId.value;
	if (id === null || proofLoading.value) return;
	proofHost.value = hostname;
	proofView.value = null;
	proofError.value = null;
	proofCheck.value = null;
	proofCheckError.value = null;
	proofLoading.value = true;
	try {
		proofView.value = await estate.startProof(id, hostname);
	} catch (error) {
		proofError.value = toApiClientError(error).message;
	} finally {
		proofLoading.value = false;
	}
}

async function checkProof(): Promise<void> {
	const id = orgId.value;
	const host = proofHost.value;
	if (id === null || host === null || proofChecking.value) return;
	proofChecking.value = true;
	proofCheck.value = null;
	proofCheckError.value = null;
	try {
		proofCheck.value = await estate.checkProof(id, host, proofMethod.value);
	} catch (error) {
		proofCheckError.value = toApiClientError(error).message;
	} finally {
		proofChecking.value = false;
	}
}

async function exportReport(): Promise<void> {
	const id = orgId.value;
	if (id === null || exporting.value) return;
	exporting.value = true;
	exportError.value = null;
	try {
		const csv = await estate.exportCsv(id, assessmentId);
		const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
		const link = document.createElement('a');
		link.href = url;
		link.download = `${assessmentId}.csv`;
		link.click();
		URL.revokeObjectURL(url);
	} catch (error) {
		exportError.value = toApiClientError(error).message;
	} finally {
		exporting.value = false;
	}
}

function printReport(): void {
	window.print();
}

async function cancelAssessment(): Promise<void> {
	const id = orgId.value;
	if (id === null || cancelling.value) return;
	cancelling.value = true;
	cancelError.value = null;
	try {
		const previous = view.value?.state;
		const next = await estate.cancel(id, assessmentId);
		view.value = next;
		poll.stop();
		if (previous !== next.state) void loadRows(true);
	} catch (error) {
		cancelError.value = toApiClientError(error).message;
	} finally {
		cancelling.value = false;
	}
}

onMounted(() => {
	poll.start();
	void loadRows(true);
});
</script>

<template>
	<ClientOnly>
		<div
			v-if="missing"
			class="max-w-3xl"
		>
			<UiErrorState
				title="Could Not Find the Assessment"
				text="This assessment does not exist, or it was removed."
			/>
		</div>

		<div
			v-else-if="loadError && view === null"
			class="max-w-3xl"
		>
			<UiErrorState
				title="Could Not Load the Assessment"
				:text="loadError"
			/>
		</div>

		<div
			v-else-if="view !== null"
			class="flex max-w-5xl flex-col gap-6"
		>
			<UiPageHeader
				title="Estate Assessment"
				text="Each site is read from the outside. Nothing on any site is changed."
			>
				<UButton
					color="neutral"
					variant="outline"
					:loading="exporting"
					:disabled="exporting"
					@click="exportReport()"
				>
					Export CSV
				</UButton>
				<UButton
					color="neutral"
					variant="outline"
					@click="printReport()"
				>
					Print Report
				</UButton>
				<UButton
					v-if="!finished"
					color="error"
					variant="outline"
					:loading="cancelling"
					:disabled="cancelling"
					@click="cancelAssessment()"
				>
					Cancel
				</UButton>
			</UiPageHeader>

			<p
				v-if="exportError || cancelError"
				role="alert"
				class="text-sm text-red-700 dark:text-red-400"
			>
				{{ exportError ?? cancelError }}
			</p>

			<div class="estate-print-area flex flex-col gap-6">
				<section class="flex flex-col gap-4 rounded-lg border border-default p-6">
					<AssessEstateProgress :view="view" />
				</section>

				<section class="flex flex-col gap-4">
					<h2 class="text-lg font-semibold text-highlighted">Sites by Class</h2>
					<AssessEstateCounts :classes="view.classes" />
					<p
						v-if="view.report"
						class="text-sm text-muted"
					>
						Effort: {{ view.report.effort.label }}. {{ view.report.effort.reason }}
					</p>
				</section>

				<section
					v-if="view.progress['needs proof'] > 0"
					class="flex flex-col gap-4"
				>
					<h2 class="text-lg font-semibold text-highlighted">Needs Proof</h2>
					<p class="text-sm text-muted">
						These sites are on domains you have not proven, so they were not checked.
						Proving a domain does not change these rows in this assessment. Choose Prove
						Ownership on a site below to see what proves the domain.
					</p>
					<AssessEstateProof
						v-if="proofHost !== null"
						v-model:method="proofMethod"
						:view="proofView"
						:loading="proofLoading"
						:error="proofError"
						:check="proofCheck"
						:checking="proofChecking"
						:check-error="proofCheckError"
						@check="checkProof()"
					/>
				</section>

				<section class="flex flex-col gap-4">
					<h2 class="text-lg font-semibold text-highlighted">Sites</h2>
					<AssessEstateRows
						:rows="rows"
						:next-cursor="rowsCursor"
						:loading="rowsLoading"
						:error="rowsError"
						@filter="applyFilter"
						@more="loadRows(false)"
						@prove="openProof($event)"
					/>
				</section>
			</div>
		</div>

		<div
			v-else
			role="status"
		>
			<span class="sr-only">Loading the assessment</span>
			<USkeleton class="h-24 w-full max-w-3xl" />
		</div>

		<template #fallback>
			<div role="status">
				<span class="sr-only">Loading the page</span>
			</div>
		</template>
	</ClientOnly>
</template>

<style>
@media print {
	body * {
		visibility: hidden;
	}
	.estate-print-area,
	.estate-print-area * {
		visibility: visible;
	}
	.estate-print-area {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
	}
}
</style>
