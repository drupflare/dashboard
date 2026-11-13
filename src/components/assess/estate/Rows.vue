<script setup lang="ts">
import { ROW_CLASSES, ROW_STATES } from '@contracts/estate';
import { CLASS_LABELS, STATE_LABELS, type RowView } from '~/shared/estate-view';

interface RowFilter {
	class: string;
	state: string;
	q: string;
}

const props = defineProps<{
	rows: RowView[];
	nextCursor: string | null;
	loading: boolean;
	error: string | null;
}>();
const emit = defineEmits<{ filter: [filter: RowFilter]; more: []; prove: [hostname: string] }>();

const filter = reactive<RowFilter>({ class: '', state: '', q: '' });

const CMS_LABELS: Record<RowView['cms'], string> = {
	drupal: 'Drupal',
	wordpress: 'WordPress',
	joomla: 'Joomla',
	unknown: 'Unknown'
};

function notesOf(row: RowView): string {
	if (row.cms === 'wordpress') return 'Not supported yet';
	const notes = [row.missing, ...row.findings.map((finding) => finding.title)].filter(Boolean);
	return notes.length > 0 ? notes.join('; ') : 'None';
}

function applyFilter(): void {
	emit('filter', { ...filter });
}
</script>

<template>
	<div class="flex flex-col gap-4">
		<form
			class="flex flex-wrap items-end gap-3 print:hidden"
			@submit.prevent="applyFilter()"
		>
			<label class="flex flex-col gap-1 text-sm font-medium text-default">
				Class
				<select
					v-model="filter.class"
					class="rounded-md border border-default bg-default px-3 py-2 font-normal text-default"
				>
					<option value="">All Classes</option>
					<option
						v-for="rowClass in ROW_CLASSES"
						:key="rowClass"
						:value="rowClass"
					>
						{{ CLASS_LABELS[rowClass] }}
					</option>
				</select>
			</label>
			<label class="flex flex-col gap-1 text-sm font-medium text-default">
				State
				<select
					v-model="filter.state"
					class="rounded-md border border-default bg-default px-3 py-2 font-normal text-default"
				>
					<option value="">All States</option>
					<option
						v-for="state in ROW_STATES"
						:key="state"
						:value="state"
					>
						{{ STATE_LABELS[state] }}
					</option>
				</select>
			</label>
			<label class="flex flex-col gap-1 text-sm font-medium text-default">
				Hostname Contains
				<input
					v-model="filter.q"
					type="text"
					class="rounded-md border border-default bg-default px-3 py-2 font-normal text-default"
				/>
			</label>
			<UButton
				type="submit"
				color="neutral"
				variant="outline"
			>
				Apply Filters
			</UButton>
		</form>

		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>

		<p
			v-else-if="!loading && rows.length === 0"
			class="text-sm text-muted"
		>
			No sites match these filters.
		</p>

		<div
			v-if="rows.length > 0"
			class="overflow-x-auto rounded-lg border border-default"
		>
			<table class="w-full text-left text-sm">
				<caption class="sr-only">
					Sites in this assessment
				</caption>
				<thead class="bg-elevated text-muted">
					<tr>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							No.
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Hostname
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Platform
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Class
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							State
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Identity
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Notes
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="row in rows"
						:key="row.number"
						class="border-t border-default align-top"
					>
						<td class="px-4 py-3 tabular-nums">{{ row.number }}</td>
						<td class="wrap-break-word px-4 py-3 font-medium text-highlighted">
							{{ row.hostname }}
						</td>
						<td class="px-4 py-3">{{ CMS_LABELS[row.cms] }}</td>
						<td class="px-4 py-3">
							{{ row.class ? CLASS_LABELS[row.class] : 'Not Set' }}
						</td>
						<td class="px-4 py-3">{{ STATE_LABELS[row.state] }}</td>
						<td class="px-4 py-3">
							{{ row.reconciled ? 'Reconciled' : 'Not Reconciled' }}
						</td>
						<td class="wrap-break-word px-4 py-3 text-muted">
							{{ notesOf(row) }}
							<div
								v-if="row.state === 'needs proof'"
								class="mt-2 print:hidden"
							>
								<UButton
									color="neutral"
									variant="outline"
									size="sm"
									@click="emit('prove', row.hostname)"
								>
									Prove Ownership
								</UButton>
							</div>
						</td>
					</tr>
				</tbody>
			</table>
		</div>

		<div v-if="nextCursor">
			<UButton
				color="neutral"
				variant="outline"
				:loading="loading"
				:disabled="loading"
				@click="emit('more')"
			>
				Load More Sites
			</UButton>
		</div>
	</div>
</template>
