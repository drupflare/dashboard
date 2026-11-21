<script setup lang="ts">
import { KEY_SCOPE_COPY, KEY_SCOPE_GROUPS } from '~/shared/api-keys';
import { ORG_ROLE_ACTIONS, type OrgRole } from '~/shared/permissions';

const props = defineProps<{ role: OrgRole }>();

// a group reads All when the role holds every action in it, Some when it holds part, and None otherwise
const rows = computed(() => {
	const held = new Set<string>(ORG_ROLE_ACTIONS[props.role]);
	return KEY_SCOPE_GROUPS.map((group) => {
		const actions = Object.entries(KEY_SCOPE_COPY)
			.filter(([, copy]) => copy.group === group.id)
			.map(([action]) => action);
		const count = actions.filter((action) => held.has(action)).length;
		const access = count === 0 ? 'None' : count === actions.length ? 'All' : 'Some';
		return { id: group.id, title: group.title, access };
	});
});
</script>

<template>
	<table class="w-full text-left text-sm">
		<caption class="sr-only">
			What the role can do, by area
		</caption>
		<thead class="text-muted">
			<tr>
				<th
					scope="col"
					class="py-1 pr-3 font-medium"
				>
					Area
				</th>
				<th
					scope="col"
					class="py-1 font-medium"
				>
					Access
				</th>
			</tr>
		</thead>
		<tbody class="divide-y divide-default">
			<tr
				v-for="row in rows"
				:key="row.id"
			>
				<th
					scope="row"
					class="py-1 pr-3 font-normal text-default"
				>
					{{ row.title }}
				</th>
				<td class="py-1 text-default">{{ row.access }}</td>
			</tr>
		</tbody>
	</table>
</template>
