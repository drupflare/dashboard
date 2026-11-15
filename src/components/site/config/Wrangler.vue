<script setup lang="ts">
import type { SettingsGroup } from '~/stores/site-config';

const props = defineProps<{ groups: SettingsGroup[] }>();

// only deploy-time variables belong in the file; owner overrides go through the settings route
const vars = computed(() => {
	const out: Record<string, unknown> = {};
	for (const group of props.groups) {
		for (const field of group.fields) {
			if (field.provenance === 'var' && field.value !== null && field.value !== undefined) {
				out[field.key] = field.value;
			}
		}
	}
	return out;
});

const text = computed(() => JSON.stringify({ vars: vars.value }, null, 2));
const empty = computed(() => Object.keys(vars.value).length === 0);

function download(): void {
	const url = URL.createObjectURL(new Blob([`${text.value}\n`], { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = 'wrangler.jsonc';
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
	<div class="flex flex-col gap-3">
		<p
			v-if="empty"
			class="text-sm text-muted"
		>
			No Deploy Settings Are Reported, So the File Has No Variables
		</p>
		<pre class="max-h-96 overflow-auto rounded-md bg-elevated p-3 font-mono text-xs">{{
			text
		}}</pre>
		<div>
			<UButton
				color="neutral"
				variant="outline"
				icon="i-lucide-download"
				@click="download"
			>
				Download wrangler.jsonc
			</UButton>
		</div>
	</div>
</template>
