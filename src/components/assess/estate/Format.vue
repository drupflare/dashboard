<script setup lang="ts">
import { INVENTORY_COLUMNS } from '@contracts/estate';
</script>

<template>
	<div class="flex flex-col gap-3 text-sm text-muted">
		<p>
			Use a CSV file with a header row, or a JSON file that holds a <code>sites</code> array
			or a bare array of sites. Only <code>hostname</code> is required. Header names are
			matched without regard to case, and spaces or hyphens count as underscores.
		</p>
		<p>
			Columns:
			<code
				v-for="(column, index) in INVENTORY_COLUMNS"
				:key="column"
				>{{ column }}{{ index < INVENTORY_COLUMNS.length - 1 ? ', ' : '' }}</code
			>
		</p>
		<p>
			A column this page does not read is ignored and listed once. A row without a hostname is
			left out and listed with its line number.
		</p>
	</div>
</template>
