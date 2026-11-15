<script setup lang="ts">
const props = defineProps<{ value: unknown }>();

// the matrix maps a role to the permissions it holds; anything else is shown as-is by the parent
const rows = computed(() => {
	if (props.value === null || typeof props.value !== 'object' || Array.isArray(props.value)) {
		return null;
	}
	return Object.entries(props.value as Record<string, unknown>).map(([role, grant]) => ({
		role,
		grants: Array.isArray(grant) ? grant.map(String) : [String(grant)]
	}));
});
</script>

<template>
	<table
		v-if="rows && rows.length"
		class="w-full text-left text-sm"
	>
		<thead>
			<tr class="border-b border-default text-muted">
				<th
					scope="col"
					class="py-1.5 pr-4 font-medium"
				>
					Role
				</th>
				<th
					scope="col"
					class="py-1.5 font-medium"
				>
					Permissions
				</th>
			</tr>
		</thead>
		<tbody>
			<tr
				v-for="row in rows"
				:key="row.role"
				class="border-b border-default last:border-0"
			>
				<th
					scope="row"
					class="py-1.5 pr-4 font-normal"
				>
					{{ row.role }}
				</th>
				<td class="py-1.5 font-mono text-xs">{{ row.grants.join(', ') || 'None' }}</td>
			</tr>
		</tbody>
	</table>
	<p
		v-else
		class="text-sm text-muted"
	>
		No Roles Set
	</p>
</template>
