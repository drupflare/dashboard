<script setup lang="ts">
import { toApiClientError, useApi } from '~/composables/useApi';
import { normalizeAddress, type PreflightResult } from '~/shared/preflight';

definePageMeta({ layout: 'public' });
useSeoMeta({
	title: 'Check a Site Address',
	description:
		'Enter a site address to see which system and version it shows to any visitor, and what only a server survey can confirm.'
});

const address = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const result = ref<PreflightResult | null>(null);
const card = ref<{ focus: () => void } | null>(null);

type Details = { retryAfterSeconds?: number };

function messageFor(raw: unknown): string {
	const failure = toApiClientError(raw);
	const seconds = (failure.details as Details | null)?.retryAfterSeconds;
	if (failure.code === 'rate_limited' && seconds) {
		return `Too many checks right now. Try again in ${seconds} seconds.`;
	}
	return failure.message;
}

async function check() {
	if (busy.value) return;
	error.value = null;
	if (address.value.trim() === '') {
		error.value = 'Enter the address of a site.';
		return;
	}
	busy.value = true;
	result.value = null;
	try {
		result.value = await useApi().post<PreflightResult>('/preflight', {
			url: normalizeAddress(address.value)
		});
		await nextTick();
		card.value?.focus();
	} catch (raw) {
		error.value = messageFor(raw);
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div class="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-12">
		<UiPageHeader
			title="Check a Site Address"
			text="See what a site shows to any visitor. No account is needed."
		/>

		<form
			class="flex flex-col gap-4"
			novalidate
			@submit.prevent="check"
		>
			<UiField
				id="preflight-address"
				label="Site Address"
				hint="For example, www.example.edu"
				:error="error"
				v-slot="{ describedBy }"
			>
				<input
					id="preflight-address"
					v-model="address"
					type="text"
					name="url"
					inputmode="url"
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					class="w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
					:aria-invalid="error ? 'true' : undefined"
					:aria-describedby="describedBy"
				/>
			</UiField>
			<div>
				<UButton
					type="submit"
					:loading="busy"
					>Check Address</UButton
				>
			</div>
			<p class="max-w-prose text-sm text-muted">
				The check sends a handful of ordinary page requests to the address you enter: the
				home page and up to three small files. It sends no cookies and reads nothing behind
				a login. Its requests identify themselves as Drupflare-Preflight. It reports what
				the site discloses and never says a site will move cleanly. To stop the checks on a
				site you run, write to support@drupflare.com.
			</p>
		</form>

		<div
			aria-live="polite"
			:aria-busy="busy"
		>
			<p
				v-if="busy"
				class="text-sm text-muted"
			>
				Checking the address. This can take up to 15 seconds.
			</p>
			<MigratePreflightResult
				v-else-if="result"
				ref="card"
				:result="result"
			/>
		</div>
	</div>
</template>
