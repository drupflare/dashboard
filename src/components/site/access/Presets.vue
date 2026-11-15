<script setup lang="ts">
import { PRESET_DESCRIPTIONS } from '~/shared/access-copy';
import type { AccessPresetView } from '~/stores/access';

defineProps<{ presets: AccessPresetView[] }>();
</script>

<template>
	<ul class="rounded-lg border border-default">
		<li
			v-for="preset in presets"
			:key="preset.id"
			class="flex flex-col gap-1 border-t border-default px-4 py-3 first:border-t-0 sm:flex-row sm:items-center sm:gap-4"
			:class="preset.available ? '' : 'opacity-60'"
			:data-preset="preset.id"
		>
			<div class="min-w-0 flex-1">
				<p class="font-medium">{{ preset.label }}</p>
				<p class="text-sm text-muted">{{ PRESET_DESCRIPTIONS[preset.id] }}</p>
			</div>
			<span
				v-if="preset.available"
				class="inline-flex items-center gap-1.5 text-sm text-success"
			>
				<UIcon
					name="i-lucide-circle-check"
					class="size-4"
					aria-hidden="true"
				/>
				Included
			</span>
			<span
				v-else
				class="inline-flex items-center gap-1.5 text-sm text-muted"
			>
				<UIcon
					name="i-lucide-lock"
					class="size-4"
					aria-hidden="true"
				/>
				Needs the {{ preset.unlockedBy }} plan
			</span>
		</li>
	</ul>
</template>
