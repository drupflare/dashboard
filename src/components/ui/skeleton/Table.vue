<script setup lang="ts">
withDefaults(defineProps<{ label: string; rows?: number; columns?: number }>(), {
	rows: 5,
	columns: 4
});
</script>

<template>
	<div role="status">
		<span class="sr-only">{{ label }}</span>
		<div
			aria-hidden="true"
			class="overflow-hidden rounded-lg border border-default"
		>
			<div
				v-for="row in rows + 1"
				:key="row"
				class="flex items-center gap-6 px-4 py-3"
				:class="row === 1 ? 'bg-elevated' : 'border-t border-default'"
			>
				<USkeleton
					v-for="column in columns"
					:key="column"
					class="h-4"
					:class="column === 1 ? 'w-40' : 'w-24'"
				/>
			</div>
		</div>
	</div>
</template>
