<script setup lang="ts">
// managed is the only plane that can be created today; the others show as disabled
const planes = [
	{ id: 'managed', name: 'Managed', hint: 'Drupflare runs and maintains the site.', soon: false },
	{
		id: 'self-managed',
		name: 'Self-Managed',
		hint: 'Run the site in your own Cloudflare account.',
		soon: true
	},
	{
		id: 'self-hosted',
		name: 'Self-Hosted',
		hint: 'Run the site on a server you control.',
		soon: true
	}
];
</script>

<template>
	<fieldset class="flex flex-col gap-3">
		<legend class="mb-2 text-sm font-medium text-default">Hosting Location</legend>
		<label
			v-for="plane in planes"
			:key="plane.id"
			:for="`plane-${plane.id}`"
			class="flex cursor-pointer items-start gap-3 rounded-lg border border-default p-4 has-checked:border-brand-600 has-checked:bg-muted has-disabled:cursor-default has-disabled:opacity-70 dark:has-checked:border-brand-400"
		>
			<input
				:id="`plane-${plane.id}`"
				type="radio"
				name="plane"
				:value="plane.id"
				:checked="plane.id === 'managed'"
				:disabled="plane.soon"
				class="mt-1 size-4 accent-primary"
			/>
			<span class="flex flex-col gap-1">
				<span class="font-medium text-highlighted">{{ plane.name }}</span>
				<span class="text-sm text-muted">{{ plane.hint }}</span>
				<span
					v-if="plane.soon"
					class="inline-flex items-center gap-1.5 text-sm text-muted"
				>
					<UIcon
						name="i-lucide-clock"
						class="size-4"
						aria-hidden="true"
					/>
					Coming Soon
				</span>
			</span>
		</label>
	</fieldset>
</template>
