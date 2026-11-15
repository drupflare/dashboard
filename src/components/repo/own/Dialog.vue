<script setup lang="ts">
import { CODE_SOURCES } from '~/shared/code-sources';

const open = defineModel<boolean>('open', { default: false });
</script>

<template>
	<UModal
		v-model:open="open"
		title="Add Your Own Code"
		description="The verified list is evidence of what runs, not a gate. Bring code that is not on it."
	>
		<template #body>
			<ul class="flex flex-col gap-5">
				<li
					v-for="source in CODE_SOURCES"
					:key="source.id"
					class="flex flex-col gap-1"
				>
					<div class="flex flex-wrap items-center justify-between gap-2">
						<span class="font-medium text-highlighted">{{ source.label }}</span>
						<UButton
							v-if="source.href"
							:to="source.href"
							color="neutral"
							variant="outline"
							>Open</UButton
						>
					</div>
					<p class="text-sm text-muted">{{ source.summary }}</p>
					<p
						v-if="source.reason"
						class="text-sm text-default"
					>
						{{ source.reason }}
					</p>
				</li>
			</ul>
		</template>
	</UModal>
</template>
