<script setup lang="ts">
import { type ApiClientError, toApiClientError, useApi } from '~/composables/useApi';

const props = defineProps<{ orgId: string; siteId: string }>();

type Phase = 'idle' | 'revealing' | 'shown' | 'gone' | 'error';

const phase = ref<Phase>('idle');
const value = ref<string | null>(null);
const failure = ref<ApiClientError | null>(null);
const copyState = ref<'idle' | 'copied' | 'failed'>('idle');

async function reveal(): Promise<void> {
	if (phase.value === 'revealing') return;
	phase.value = 'revealing';
	failure.value = null;
	try {
		const reply = await useApi().post<{ kind: string; value: string }>(
			`/orgs/${encodeURIComponent(props.orgId)}/sites/${encodeURIComponent(props.siteId)}/first-run-secret`
		);
		value.value = reply.value;
		phase.value = 'shown';
	} catch (error) {
		const apiError = toApiClientError(error);
		if (apiError.status === 404) {
			phase.value = 'gone';
			return;
		}
		failure.value = apiError;
		phase.value = 'error';
	}
}

async function copy(): Promise<void> {
	if (value.value === null) return;
	try {
		await navigator.clipboard.writeText(value.value);
		copyState.value = 'copied';
	} catch {
		copyState.value = 'failed';
	}
}

// the password lives only in this component while it is shown
onBeforeUnmount(() => {
	value.value = null;
	copyState.value = 'idle';
});
</script>

<template>
	<div class="flex flex-col gap-3">
		<template v-if="phase === 'idle' || phase === 'revealing'">
			<p class="text-sm text-muted">
				The site generated an admin password. You can reveal it once.
			</p>
			<div>
				<UButton
					color="primary"
					variant="solid"
					:loading="phase === 'revealing'"
					@click="reveal()"
				>
					Reveal Password
				</UButton>
			</div>
		</template>

		<template v-else-if="phase === 'shown' && value !== null">
			<p class="flex items-start gap-1.5 text-sm text-amber-800 dark:text-amber-300">
				<UIcon
					name="i-lucide-triangle-alert"
					class="mt-0.5 size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>This password will not be shown again. Save it now.</span>
			</p>
			<code
				class="break-all rounded-md bg-elevated px-3 py-2 text-sm text-highlighted select-all"
				>{{ value }}</code
			>
			<div class="flex flex-wrap items-center gap-3">
				<UButton
					color="neutral"
					variant="outline"
					icon="i-lucide-copy"
					@click="copy()"
				>
					Copy Password
				</UButton>
				<span
					role="status"
					class="text-sm text-muted"
				>
					<template v-if="copyState === 'copied'">Copied</template>
					<template v-else-if="copyState === 'failed'"
						>Copy Failed. Select the password and copy it.</template
					>
				</span>
			</div>
		</template>

		<UiEmptyState
			v-else-if="phase === 'gone'"
			icon="i-lucide-key-round"
			title="Already Shown"
			text="The admin password is shown only once and is not kept. Reset it from the site's sign-in page."
		/>

		<UiErrorState
			v-else
			title="Could Not Reveal the Password"
			text="Check your connection and try again."
			:request-id="failure?.requestId"
		>
			<UButton
				color="neutral"
				@click="reveal()"
			>
				Try Again
			</UButton>
		</UiErrorState>
	</div>
</template>
