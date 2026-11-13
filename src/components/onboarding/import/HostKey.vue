<script setup lang="ts">
import { toApiClientError, type ApiClientError } from '~/composables/useApi';
import { importRefusalReason } from '~/shared/operation-copy';
import { useImportsStore, type ImportHostKey } from '~/stores/imports';

const props = defineProps<{ orgId: string; credentialId: string }>();
const emit = defineEmits<{ confirmed: []; back: []; restart: [] }>();

const imports = useImportsStore();

// the key changed or another key was confirmed: the only way on is a new key
const RESTART_REASONS: ReadonlySet<string> = new Set(['host_key_changed', 'host_key_confirmed']);
const ADDRESS_REASONS: ReadonlySet<string> = new Set(['host_private', 'host_unresolved']);

const phase = ref<'reading' | 'ready' | 'confirming' | 'error'>('reading');
const hostKey = ref<ImportHostKey | null>(null);
const failure = ref<ApiClientError | null>(null);
const failedAt = ref<'read' | 'confirm'>('read');

const reason = computed(() => {
	const value = (failure.value?.details as { reason?: unknown } | null)?.reason;
	return typeof value === 'string' ? value : null;
});

const failureText = computed(() =>
	failure.value === null ? '' : importRefusalReason(failure.value)
);

async function read(): Promise<void> {
	phase.value = 'reading';
	failure.value = null;
	failedAt.value = 'read';
	try {
		hostKey.value = await imports.readHostKey(props.orgId, props.credentialId);
		phase.value = 'ready';
	} catch (error) {
		failure.value = toApiClientError(error);
		phase.value = 'error';
	}
}

async function confirm(): Promise<void> {
	if (hostKey.value === null || phase.value === 'confirming') return;
	phase.value = 'confirming';
	failure.value = null;
	failedAt.value = 'confirm';
	try {
		hostKey.value = await imports.readHostKey(
			props.orgId,
			props.credentialId,
			hostKey.value.fingerprint
		);
		emit('confirmed');
	} catch (error) {
		failure.value = toApiClientError(error);
		phase.value = 'error';
	}
}

function retry(): void {
	if (failedAt.value === 'confirm' && hostKey.value !== null) void confirm();
	else void read();
}

onMounted(() => void read());
</script>

<template>
	<div class="flex flex-col gap-6">
		<div
			v-if="phase === 'reading'"
			role="status"
			class="flex flex-col gap-3"
		>
			<span class="sr-only">Reading the host key of your server</span>
			<USkeleton
				class="h-5 w-48 max-w-full"
				aria-hidden="true"
			/>
			<USkeleton
				class="h-9 w-full"
				aria-hidden="true"
			/>
		</div>

		<template v-else-if="hostKey !== null && phase !== 'error'">
			<p class="text-sm text-default">
				Check this matches what your server reports. Nothing else runs on your server until
				you confirm it.
			</p>
			<dl class="flex flex-col gap-3 text-sm">
				<div class="flex flex-col gap-1">
					<dt class="text-muted">Key Type</dt>
					<dd class="font-medium text-highlighted">{{ hostKey.hostKeyType }}</dd>
				</div>
				<div class="flex flex-col gap-1">
					<dt class="text-muted">Fingerprint</dt>
					<dd>
						<code
							class="break-all rounded-md bg-elevated px-3 py-2 text-highlighted select-all"
							>{{ hostKey.fingerprint }}</code
						>
					</dd>
				</div>
			</dl>
			<div class="flex flex-wrap gap-3">
				<UButton
					color="neutral"
					variant="outline"
					@click="emit('back')"
				>
					Back
				</UButton>
				<UButton
					color="primary"
					variant="solid"
					:loading="phase === 'confirming'"
					:disabled="phase === 'confirming'"
					@click="confirm()"
				>
					Confirm the Host Key
				</UButton>
			</div>
		</template>

		<section
			v-else
			role="alert"
			class="flex flex-col gap-3 rounded-lg border border-red-700/40 p-5 dark:border-red-400/40"
		>
			<p class="flex items-start gap-1.5 text-sm text-red-700 dark:text-red-400">
				<UIcon
					name="i-lucide-triangle-alert"
					class="mt-0.5 size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>{{ failureText }}</span>
			</p>
			<p
				v-if="failure?.requestId"
				class="text-xs text-muted"
			>
				Request ID: <code class="break-all">{{ failure.requestId }}</code>
			</p>
			<div class="flex flex-wrap gap-3">
				<UButton
					v-if="reason !== null && RESTART_REASONS.has(reason)"
					color="primary"
					variant="solid"
					@click="emit('restart')"
				>
					Start Over
				</UButton>
				<UButton
					v-else-if="reason !== null && ADDRESS_REASONS.has(reason)"
					color="neutral"
					variant="outline"
					@click="emit('back')"
				>
					Change the Address
				</UButton>
				<UButton
					v-else
					color="neutral"
					@click="retry()"
				>
					Try Again
				</UButton>
			</div>
		</section>
	</div>
</template>
