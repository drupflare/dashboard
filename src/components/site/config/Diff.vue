<script setup lang="ts">
export interface DiffRow {
	key: string;
	label: string;
	before: unknown;
	after: unknown;
	// what the site holds now; set only when it changed since the page loaded
	theirs?: unknown;
}

defineProps<{ rows: DiffRow[] }>();

function show(value: unknown): string {
	return value === null || value === undefined || value === '' ? 'Default' : String(value);
}
</script>

<template>
	<div
		class="overflow-x-auto"
		tabindex="0"
		role="region"
		aria-label="Settings Changes"
	>
		<table class="w-full text-left text-sm">
			<caption class="sr-only">
				Settings changes
			</caption>
			<thead>
				<tr class="border-b border-default text-muted">
					<th
						scope="col"
						class="py-1.5 pr-4 font-medium"
					>
						Setting
					</th>
					<th
						scope="col"
						class="py-1.5 pr-4 font-medium"
					>
						Before
					</th>
					<th
						v-if="rows.some((row) => row.theirs !== undefined)"
						scope="col"
						class="py-1.5 pr-4 font-medium"
					>
						On the Site Now
					</th>
					<th
						scope="col"
						class="py-1.5 font-medium"
					>
						After
					</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="row in rows"
					:key="row.key"
					class="border-b border-default last:border-0"
				>
					<th
						scope="row"
						class="py-1.5 pr-4 font-medium"
					>
						{{ row.label }}
					</th>
					<td class="py-1.5 pr-4 font-mono text-xs">{{ show(row.before) }}</td>
					<td
						v-if="rows.some((other) => other.theirs !== undefined)"
						class="py-1.5 pr-4 font-mono text-xs"
					>
						{{ row.theirs === undefined ? 'Same as before' : show(row.theirs) }}
					</td>
					<td class="py-1.5 font-mono text-xs">{{ show(row.after) }}</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
