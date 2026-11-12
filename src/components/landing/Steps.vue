<script setup lang="ts">
const steps = [
	'Locking the site for this change',
	'Reserving quiet-otter-lamp',
	'Creating the site storage',
	'Uploading static files',
	'Uploading the site code',
	"Recording the site's access rules",
	'Connecting quiet-otter-lamp.drupflare.app',
	'Checking that the site answers',
	'Marking the site ready'
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
			An example run. The dashboard shows each step as it finishes.
		</p>
	</figure>
</template>
