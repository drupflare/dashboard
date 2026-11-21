<script setup lang="ts">
import { adminGet } from '~/composables/useAdminApi';
import { toApiClientError, useApi } from '~/composables/useApi';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Database Console' });

interface Shard {
	shard: string;
	sizeBytes: number | null;
}
interface Result {
	shard: string;
	columns: string[];
	rows: Record<string, unknown>[];
	truncated: boolean;
	explain: boolean;
}
interface Saved {
	id: string;
	name: string;
	statement: string;
	createdBy: string;
	createdAt: number;
}

const session = useSessionStore();
const shards = ref<Shard[]>([]);
const saved = ref<Saved[]>([]);
const statement = ref('SELECT id, name, state FROM sites');
const shard = ref('directory');
const explain = ref(false);
const results = ref<Result[]>([]);
const busy = ref(false);
const failure = ref<string | null>(null);
const needsStepUp = ref(false);
const saveName = ref('');
const loadError = ref<string | null>(null);

const shardItems = computed(() => [
	{ label: 'Directory Shard', value: 'directory' },
	{ label: 'All Shards', value: 'all' },
	...shards.value.map((s) => ({ label: s.shard, value: s.shard }))
]);

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

async function loadAside(): Promise<void> {
	loadError.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	try {
		shards.value = (await adminGet<{ shards: Shard[] }>('/admin/db/shards')).shards;
		saved.value = (await adminGet<{ items: Saved[] }>('/admin/db/queries')).items;
	} catch (cause) {
		const problem = toApiClientError(cause);
		const details = problem.details as { requires?: string } | null;
		if (details?.requires === 'step-up') needsStepUp.value = true;
		else loadError.value = problem.message;
	}
}

onMounted(() => void loadAside());

async function run(): Promise<void> {
	failure.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		results.value = (
			await useApi().post<{ results: Result[] }>('/admin/db/query', {
				statement: statement.value,
				shard: shard.value,
				explain: explain.value
			})
		).results;
	} catch (cause) {
		const problem = toApiClientError(cause);
		const details = problem.details as { requires?: string } | null;
		if (details?.requires === 'step-up') needsStepUp.value = true;
		else failure.value = problem.message;
		results.value = [];
	} finally {
		busy.value = false;
	}
}

async function save(): Promise<void> {
	failure.value = null;
	try {
		await useApi().post('/admin/db/queries', {
			name: saveName.value.trim(),
			statement: statement.value
		});
		saveName.value = '';
		await loadAside();
	} catch (cause) {
		failure.value = toApiClientError(cause).message;
	}
}

async function remove(row: Saved): Promise<void> {
	try {
		await useApi().delete(`/admin/db/queries/${row.id}`);
		await loadAside();
	} catch (cause) {
		failure.value = toApiClientError(cause).message;
	}
}

function stepUpDone(): void {
	needsStepUp.value = false;
	void loadAside();
}

const cell = (value: unknown) =>
	value === null || value === undefined
		? 'null'
		: typeof value === 'object'
			? JSON.stringify(value)
			: String(value);
</script>

<template>
	<UiEmptyState
		v-if="session.me !== undefined && session.me?.platformRole !== 'admin'"
		icon="i-lucide-file-question"
		title="Page Not Found"
		text="There is nothing at this address."
	/>
	<div
		v-else
		class="flex flex-col gap-6"
	>
		<UiPageHeader
			title="Database Console"
			text="One read-only SELECT at a time, on one shard or all of them. Results stop at 200 rows. Secret columns are refused. Every statement is audited with its text."
		/>
		<AccountStepUp
			v-if="needsStepUp"
			@done="stepUpDone()"
			@cancel="needsStepUp = false"
		/>
		<p
			v-if="loadError"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ loadError }}
		</p>
		<form
			class="flex max-w-3xl flex-col gap-3"
			aria-labelledby="query-title"
			@submit.prevent="run"
		>
			<h2
				id="query-title"
				class="text-lg font-semibold text-highlighted"
			>
				Query
			</h2>
			<UiField
				id="db-shard"
				label="Shard"
			>
				<template #default="{ describedBy }">
					<USelect
						id="db-shard"
						v-model="shard"
						:items="shardItems"
						:aria-describedby="describedBy"
						class="w-full"
					/>
				</template>
			</UiField>
			<UiField
				id="db-statement"
				label="Statement"
			>
				<template #default="{ describedBy }">
					<UTextarea
						id="db-statement"
						v-model="statement"
						:rows="6"
						:aria-describedby="describedBy"
						class="w-full font-mono"
					/>
				</template>
			</UiField>
			<UCheckbox
				v-model="explain"
				label="Show the query plan instead of rows"
			/>
			<p
				v-if="failure"
				role="alert"
				class="text-sm text-red-700 dark:text-red-400"
			>
				{{ failure }}
			</p>
			<div class="flex flex-wrap gap-2">
				<UButton
					type="submit"
					color="neutral"
					:loading="busy"
					:disabled="statement.trim() === ''"
					>Run Query</UButton
				>
				<UInput
					v-model="saveName"
					placeholder="Name to save under"
					aria-label="Saved query name"
				/>
				<UButton
					color="neutral"
					variant="outline"
					:disabled="saveName.trim() === '' || statement.trim() === ''"
					@click="save()"
					>Save Query</UButton
				>
			</div>
		</form>

		<section
			v-for="result in results"
			:key="result.shard"
			class="flex flex-col gap-2"
		>
			<h2 class="text-lg font-semibold text-highlighted">
				{{ result.shard }}{{ result.explain ? ' (query plan)' : '' }}
			</h2>
			<p
				v-if="result.rows.length === 0"
				class="text-muted"
			>
				No rows.
			</p>
			<div
				v-else
				class="overflow-x-auto rounded-lg border border-default"
				tabindex="0"
				role="region"
				aria-label="Query Results"
			>
				<table class="w-full text-left font-mono text-xs">
					<thead class="bg-elevated text-muted">
						<tr>
							<th
								v-for="column in result.columns"
								:key="column"
								scope="col"
								class="px-3 py-2 font-medium"
							>
								{{ column }}
							</th>
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="(row, index) in result.rows"
							:key="index"
							class="border-t border-default"
						>
							<td
								v-for="column in result.columns"
								:key="column"
								class="px-3 py-2"
							>
								{{ cell(row[column]) }}
							</td>
						</tr>
					</tbody>
				</table>
			</div>
			<p
				v-if="result.truncated"
				class="text-sm text-muted"
			>
				Showing the first 200 rows.
			</p>
		</section>

		<section class="flex flex-col gap-2">
			<h2 class="text-lg font-semibold text-highlighted">Saved Queries</h2>
			<p
				v-if="saved.length === 0"
				class="text-muted"
			>
				No saved queries.
			</p>
			<ul class="flex flex-col gap-2 text-sm">
				<li
					v-for="row in saved"
					:key="row.id"
					class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-default p-3"
				>
					<span>
						<strong class="text-highlighted">{{ row.name }}</strong>
						<code class="ml-2 text-xs">{{ row.statement }}</code>
					</span>
					<span class="flex gap-2">
						<UButton
							color="neutral"
							variant="outline"
							size="xs"
							@click="statement = row.statement"
							>Use</UButton
						>
						<UButton
							color="neutral"
							variant="outline"
							size="xs"
							@click="remove(row)"
							>Delete</UButton
						>
					</span>
				</li>
			</ul>
		</section>
	</div>
</template>
