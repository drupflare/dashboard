<script setup lang="ts">
import { buildTree, type DepartmentView } from '~/shared/departments';

const props = defineProps<{ departments: DepartmentView[] }>();

const roots = computed(() => buildTree(props.departments));
</script>

<template>
	<ul
		aria-label="Departments"
		class="divide-y divide-default rounded-lg border border-default px-4"
	>
		<TeamDepartmentNode
			v-for="root in roots"
			:key="root.department.id"
			:node="root"
		/>
	</ul>
</template>
