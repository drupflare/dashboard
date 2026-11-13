<script setup lang="ts">
import { claudeMcpAddCommand, type KeyCreated, type McpFilters } from '~/shared/api-keys';

defineProps<{ created: KeyCreated }>();

const readOnly = ref(false);
const confirmWrites = ref(false);
const copied = ref<'token' | 'command' | 'failed' | null>(null);

const command = computed(() => {
	const filters: McpFilters = {
		...(readOnly.value ? { methods: ['get'] } : {}),
		...(confirmWrites.value ? { confirm: 'write' as const } : {})
	};
	return claudeMcpAddCommand(filters);
});

async function copy(what: 'token' | 'command', text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		copied.value = what;
	} catch {
		copied.value = 'failed';
	}
}
</script>

<template>
	<section class="flex flex-col gap-4">
		<p class="flex items-start gap-1.5 text-sm text-amber-800 dark:text-amber-300">
			<UIcon
				name="i-lucide-triangle-alert"
				class="mt-0.5 size-4 shrink-0"
				aria-hidden="true"
			/>
			<span>This key will not be shown again. Copy it now.</span>
		</p>

		<div class="flex flex-col gap-2">
			<h3 class="font-semibold text-highlighted">Your Key</h3>
			<code
				class="break-all rounded-md bg-elevated px-3 py-2 text-sm text-highlighted select-all"
				>{{ created.token }}</code
			>
			<div>
				<UButton
					color="neutral"
					variant="outline"
					icon="i-lucide-copy"
					@click="copy('token', created.token)"
					>Copy Key</UButton
				>
			</div>
		</div>

		<div class="flex flex-col gap-2">
			<h3 class="font-semibold text-highlighted">Connect Claude Code</h3>
			<p class="text-sm text-default">
				Run this where Claude Code is installed. Replace the placeholder with the key above.
				The key goes in a header and never in the address.
			</p>
			<label class="flex items-center gap-2 text-sm text-default">
				<input
					v-model="readOnly"
					type="checkbox"
					class="size-4"
				/>
				<span>Offer read tools only</span>
			</label>
			<label class="flex items-center gap-2 text-sm text-default">
				<input
					v-model="confirmWrites"
					type="checkbox"
					class="size-4"
				/>
				<span>Ask before any change</span>
			</label>
			<code
				data-command
				class="break-all rounded-md bg-elevated px-3 py-2 text-sm text-highlighted select-all"
				>{{ command }}</code
			>
			<div>
				<UButton
					color="neutral"
					variant="outline"
					icon="i-lucide-copy"
					@click="copy('command', command)"
					>Copy Command</UButton
				>
			</div>
		</div>

		<span
			role="status"
			class="text-sm text-muted"
		>
			<template v-if="copied === 'token'">Key copied</template>
			<template v-else-if="copied === 'command'">Command copied</template>
			<template v-else-if="copied === 'failed'"
				>Copy failed. Select the text and copy it.</template
			>
		</span>
	</section>
</template>
