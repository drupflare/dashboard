<script setup lang="ts">
import { LINK_STATE_COPY, linkStateOf, type NodeView } from '~/shared/nodes';

const props = defineProps<{ nodes: NodeView[]; now: number }>();
const selected = defineModel<string | null>({ required: true });

const rows = computed(() =>
	props.nodes
		.filter((node) => node.state === 'active')
		.map((node) => {
			const state = linkStateOf(node, props.now);
			return { node, state, usable: state === 'connected', why: LINK_STATE_COPY[state] };
		})
);
</script>

<template>
	<fieldset class="flex flex-col gap-3">
		<legend class="mb-1 text-sm font-medium text-highlighted">Box</legend>
		<label
			v-for="row in rows"
			:key="row.node.id"
			class="flex items-start gap-3 rounded-lg border border-default p-4"
			:class="row.usable ? 'cursor-pointer' : 'opacity-70'"
		>
			<input
				v-model="selected"
				type="radio"
				name="box"
				class="mt-1"
				:value="row.node.id"
				:disabled="!row.usable"
			/>
			<span class="flex min-w-0 flex-col gap-1">
				<span class="wrap-break-word font-medium text-highlighted">{{
					row.node.name
				}}</span>
				<span class="text-sm text-muted">{{ row.node.os }} {{ row.node.arch }}</span>
				<span
					v-if="!row.usable"
					class="text-sm text-muted"
					>{{ row.why }}</span
				>
			</span>
		</label>
	</fieldset>
</template>
