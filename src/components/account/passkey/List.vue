<script setup lang="ts">
import { usePasskeysStore } from '~/stores/passkeys';

const passkeys = usePasskeysStore();

const load = () => passkeys.load();

onMounted(load);
</script>

<template>
	<div
		v-if="passkeys.items === undefined && passkeys.error === null"
		role="status"
	>
		<span class="sr-only">Loading passkeys</span>
		<div
			aria-hidden="true"
			class="flex flex-col divide-y divide-default rounded-lg border border-default"
		>
			<div
				v-for="row in 2"
				:key="row"
				class="flex items-center justify-between gap-3 p-4"
			>
				<USkeleton class="h-5 w-28" />
				<USkeleton class="h-8 w-24" />
			</div>
		</div>
	</div>
	<UiErrorState
		v-else-if="passkeys.items === undefined"
		title="Passkeys Could Not Load"
		:text="passkeys.error?.message"
		:request-id="passkeys.error?.requestId"
	>
		<UButton
			color="neutral"
			variant="outline"
			@click="load"
			>Try Again</UButton
		>
	</UiErrorState>
	<UiEmptyState
		v-else-if="passkeys.items.length === 0"
		icon="i-lucide-fingerprint"
		title="No Passkeys Yet"
		text="Add a passkey to sign in without an email code."
	/>
	<ul
		v-else
		class="flex flex-col divide-y divide-default rounded-lg border border-default"
	>
		<AccountPasskeyRow
			v-for="passkey in passkeys.items"
			:key="passkey.id"
			:passkey="passkey"
		/>
	</ul>
</template>
