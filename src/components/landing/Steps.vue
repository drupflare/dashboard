<script setup lang="ts">
const steps = [
	'Take the site writer lease',
	'Reserve quiet-otter-lamp',
	'Create the site storage',
	'Upload static assets',
	'Upload the script',
	'Write site authority',
	'Route quiet-otter-lamp.drupflare.app',
	'Probe the site',
	'Mark the site active'
];
</script>

<template>
	<figure class="rounded-lg border border-default bg-muted">
		<figcaption class="border-b border-default px-5 py-4">
			<p class="text-sm text-muted">Creating</p>
			<p class="font-mono text-base text-highlighted">quiet-otter-lamp.drupflare.app</p>
		</figcaption>
		<ol class="divide-y divide-default px-5">
			<li
				v-for="step in steps"
				:key="step"
				class="flex items-center gap-3 py-2.5 text-sm"
			>
				<UIcon
					name="i-lucide-circle-check"
					class="size-4 shrink-0 text-leaf-700 dark:text-leaf-300"
					aria-hidden="true"
				/>
				<span class="text-default">{{ step }}</span>
			</li>
		</ol>
		<p class="border-t border-default px-5 py-3 text-xs text-muted">
			An example run. The operation records each step.
		</p>
	</figure>
</template>
