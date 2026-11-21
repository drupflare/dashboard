<script setup lang="ts">
import { DEPARTMENT_KIND_LABEL, quotaText, type TreeNode } from '~/shared/departments';

defineOptions({ name: 'TeamDepartmentNode' });
defineProps<{ node: TreeNode }>();
</script>

<template>
	<li>
		<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
			<div class="flex min-w-0 flex-col">
				<NuxtLink
					:to="`/org/departments/${encodeURIComponent(node.department.id)}`"
					class="font-medium wrap-break-word text-highlighted underline-offset-2 hover:underline"
					>{{ node.department.name }}</NuxtLink
				>
				<span class="text-xs text-muted">{{
					DEPARTMENT_KIND_LABEL[node.department.kind]
				}}</span>
			</div>
			<dl class="flex flex-wrap gap-x-5 gap-y-1 text-sm text-default">
				<div class="flex gap-1">
					<dt class="text-muted">Sites</dt>
					<dd>{{ quotaText(node.department) }}</dd>
				</div>
				<div class="flex gap-1">
					<dt class="text-muted">Members</dt>
					<dd>{{ node.department.memberCount }}</dd>
				</div>
			</dl>
		</div>
		<ul
			v-if="node.children.length > 0"
			class="ml-4 border-l border-default pl-4"
		>
			<TeamDepartmentNode
				v-for="child in node.children"
				:key="child.department.id"
				:node="child"
			/>
		</ul>
	</li>
</template>
