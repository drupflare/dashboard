<script setup lang="ts">
import type { SettingsField, SettingsGroup } from '~/stores/site-config';

const props = defineProps<{ groups: SettingsGroup[] }>();

const rows = computed(() =>
	props.groups.flatMap((group) => group.fields.map((field) => ({ group: group.label, field })))
);

function display(field: SettingsField): string {
	const { value } = field;
	if (value === null || value === undefined || value === '') return 'Not Set';
	if (field.widget === 'secret') return 'Set';
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}
</script>

<template>
	<table
		v-if="rows.length"
		class="w-full text-left text-sm"
	>
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
					Value
				</th>
				<th
					scope="col"
					class="py-1.5 font-medium"
				>
					Source
				</th>
			</tr>
		</thead>
		<tbody>
			<tr
				v-for="row in rows"
				:key="row.field.key"
				class="border-b border-default align-top last:border-0"
			>
				<th
					scope="row"
					class="py-2 pr-4 font-normal"
				>
					{{ row.field.label }}
					<span class="block font-mono text-xs text-muted">{{ row.field.key }}</span>
				</th>
				<td class="max-w-xs break-words py-2 pr-4 font-mono text-xs">
					{{ display(row.field) }}
				</td>
				<td class="py-2">
					<SiteConfigProvenance :provenance="row.field.provenance" />
				</td>
			</tr>
		</tbody>
	</table>
	<p
		v-else
		class="text-sm text-muted"
	>
		No Settings to Show
	</p>
</template>
