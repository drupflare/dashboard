<script setup lang="ts">
import type { SettingsField } from '~/stores/site-config';

defineProps<{ provenance: SettingsField['provenance'] }>();

const LABELS: Record<NonNullable<SettingsField['provenance']>, { text: string; icon: string }> = {
	default: { text: 'Default', icon: 'i-lucide-circle-dashed' },
	var: { text: 'Deploy Setting', icon: 'i-lucide-file-cog' },
	kv: { text: 'Owner Override', icon: 'i-lucide-user-round-pen' },
	override: { text: 'Owner Override', icon: 'i-lucide-user-round-pen' }
};
const UNKNOWN = { text: 'Not Reported', icon: 'i-lucide-circle-help' };
</script>

<template>
	<span
		class="inline-flex items-center gap-1 rounded-md bg-elevated px-2 py-0.5 text-xs text-muted"
	>
		<UIcon
			:name="provenance ? LABELS[provenance].icon : UNKNOWN.icon"
			class="size-3.5"
		/>
		{{ provenance ? LABELS[provenance].text : UNKNOWN.text }}
	</span>
</template>
