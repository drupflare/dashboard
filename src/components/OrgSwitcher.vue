<script setup lang="ts">
const org = useOrgStore();
const selectId = useId();

// pages without the org middleware, like admin, would otherwise leave the list empty
onMounted(() => {
	void org.ensure();
});

function onChange(event: Event) {
	org.select((event.target as HTMLSelectElement).value);
}
</script>

<template>
	<div
		v-if="org.items === undefined && !org.error"
		role="status"
	>
		<span class="sr-only">Loading organizations</span>
		<div
			aria-hidden="true"
			class="flex items-center gap-2"
		>
			<USkeleton class="h-5 w-20" />
			<USkeleton class="h-8 w-48" />
		</div>
	</div>
	<div
		v-else
		class="flex items-center gap-2"
	>
		<label
			:for="selectId"
			class="text-sm text-muted"
			>Organization</label
		>
		<select
			:id="selectId"
			class="max-w-56 rounded-md border border-default bg-default px-2 py-1.5 text-sm text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
			:value="org.currentId ?? ''"
			:disabled="!org.items?.length"
			@change="onChange"
		>
			<option
				v-for="item in org.items"
				:key="item.id"
				:value="item.id"
			>
				{{ item.name }}
			</option>
		</select>
	</div>
</template>
