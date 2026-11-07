<script setup lang="ts">
import { toApiClientError, useApi } from '~/composables/useApi';

type Row = Record<string, unknown>;
interface Column {
	key: string;
	label: string;
	kind?: 'text' | 'date' | 'mono';
}

const props = defineProps<{ path: string; columns: Column[]; empty: string }>();

const rows = ref<Row[]>([]);
const next = ref<number | null>(null);
const status = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');

async function load(more: boolean) {
	status.value = 'loading';
	try {
		const query: Record<string, string> = { limit: '25' };
		if (more && next.value !== null) query.before = String(next.value);
		const page = await useApi().get<{ items: Row[]; nextBefore: number | null }>(
			props.path,
			query
		);
		rows.value = more ? [...rows.value, ...page.items] : page.items;
		next.value = page.nextBefore;
		status.value = 'ready';
	} catch (cause) {
		error.value = toApiClientError(cause).message;
		status.value = 'error';
	}
}

onMounted(() => load(false));

function cell(row: Row, column: Column): string {
	const value = row[column.key];
	if (value === null || value === undefined || value === '') return 'None';
	if (column.kind === 'date' && typeof value === 'number') {
		return new Date(value).toISOString().slice(0, 16).replace('T', ' ');
	}
	return String(value);
}
</script>

<template>
	<div class="flex flex-col gap-4">
		<UiErrorState
			v-if="status === 'error'"
			title="Could Not Load This List"
			:text="error"
		>
			<UButton
				color="neutral"
				@click="load(false)"
				>Try Again</UButton
			>
		</UiErrorState>
		<p
			v-else-if="status === 'loading' && rows.length === 0"
			role="status"
			class="text-sm text-muted"
		>
			Loading...
		</p>
		<p
			v-else-if="rows.length === 0"
			class="text-muted"
		>
			{{ empty }}
		</p>
		<div
			v-else
			class="overflow-x-auto rounded-lg border border-default"
		>
			<table class="w-full text-left text-sm">
				<thead class="bg-elevated text-muted">
					<tr>
						<th
							v-for="column in columns"
							:key="column.key"
							scope="col"
							class="px-4 py-3 font-medium whitespace-nowrap"
						>
							{{ column.label }}
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="(row, index) in rows"
						:key="String(row.id ?? index)"
						class="border-t border-default"
					>
						<td
							v-for="column in columns"
							:key="column.key"
							class="px-4 py-3"
							:class="[
								column.kind === 'mono' ? 'font-mono text-xs' : '',
								column.kind === 'date' ? 'whitespace-nowrap text-muted' : ''
							]"
						>
							{{ cell(row, column) }}
						</td>
					</tr>
				</tbody>
			</table>
		</div>
		<div
			v-if="next !== null"
			class="flex justify-center"
		>
			<UButton
				color="neutral"
				variant="outline"
				:loading="status === 'loading'"
				@click="load(true)"
				>Load More</UButton
			>
		</div>
	</div>
</template>
