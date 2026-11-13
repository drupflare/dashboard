<script setup lang="ts">
import type { CheckView } from '~/shared/estate-view';

defineProps<{ check: CheckView }>();
</script>

<template>
	<div class="flex flex-col gap-4">
		<p
			v-if="check.fileError"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ check.fileError }}
		</p>

		<dl
			v-else
			class="grid grid-cols-2 gap-4 sm:grid-cols-4"
		>
			<div class="flex flex-col gap-1">
				<dt class="text-sm text-muted">Rows Read</dt>
				<dd class="text-lg font-semibold text-highlighted">{{ check.rows }}</dd>
			</div>
			<div class="flex flex-col gap-1">
				<dt class="text-sm text-muted">Sites</dt>
				<dd class="text-lg font-semibold text-highlighted">{{ check.sites }}</dd>
			</div>
			<div class="flex flex-col gap-1">
				<dt class="text-sm text-muted">Not Reconciled</dt>
				<dd class="text-lg font-semibold text-highlighted">{{ check.notReconciled }}</dd>
			</div>
			<div class="flex flex-col gap-1">
				<dt class="text-sm text-muted">Rejected Rows</dt>
				<dd class="text-lg font-semibold text-highlighted">{{ check.rejectedTotal }}</dd>
			</div>
		</dl>

		<p
			v-if="!check.fileError && check.ignoredColumns.length > 0"
			class="text-sm text-muted"
		>
			Ignored columns: {{ check.ignoredColumns.join(', ') }}
		</p>

		<div
			v-if="check.rejected.length > 0"
			class="flex flex-col gap-2"
		>
			<h3 class="text-base font-semibold text-highlighted">Rejected Rows</h3>
			<p
				v-if="check.rejectedTotal > check.rejected.length"
				class="text-sm text-muted"
			>
				Showing {{ check.rejected.length }} of {{ check.rejectedTotal }} rejected rows.
			</p>
			<div class="overflow-x-auto rounded-lg border border-default">
				<table class="w-full text-left text-sm">
					<thead class="bg-elevated text-muted">
						<tr>
							<th
								scope="col"
								class="px-4 py-3 font-medium"
							>
								Line
							</th>
							<th
								scope="col"
								class="px-4 py-3 font-medium"
							>
								Reason
							</th>
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="row in check.rejected"
							:key="`${row.line}-${row.reason}`"
							class="border-t border-default"
						>
							<td class="px-4 py-3 font-medium text-highlighted">{{ row.line }}</td>
							<td class="px-4 py-3">{{ row.reason }}</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	</div>
</template>
