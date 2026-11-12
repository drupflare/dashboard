<script setup lang="ts">
import { tokenTemplateUrl } from '~/shared/cloudflare-probe';

const props = defineProps<{ busy: boolean; error?: string | null }>();
const emit = defineEmits<{ submit: [] }>();
const token = defineModel<string>('token', { required: true });

const TOKEN_ID = 'cloudflare-token';
const templateUrl = tokenTemplateUrl();

const canSubmit = computed(() => token.value.trim() !== '' && !props.busy);

function submit(): void {
	if (canSubmit.value) emit('submit');
}
</script>

<template>
	<form
		class="flex flex-col gap-5"
		@submit.prevent="submit"
	>
		<p class="text-sm text-default">
			Drupflare reads what this token can reach on your account, then shows you the result. It
			does not store the token and it does not create anything in your account.
		</p>
		<a
			:href="templateUrl"
			target="_blank"
			rel="noopener noreferrer"
			class="w-fit text-sm font-medium text-primary underline underline-offset-4"
		>
			Create a Token With These Permissions
		</a>
		<div class="flex flex-col gap-1.5">
			<label
				:for="TOKEN_ID"
				class="text-sm font-medium text-default"
				>API Token</label
			>
			<input
				:id="TOKEN_ID"
				v-model="token"
				type="password"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				:aria-invalid="props.error ? 'true' : undefined"
				:aria-describedby="props.error ? `${TOKEN_ID}-error` : undefined"
				class="rounded-md border border-default bg-default px-3 py-2 font-mono text-sm text-default"
			/>
			<p class="text-sm text-muted">Paste the token. It is checked, not saved.</p>
			<p
				v-if="props.error"
				:id="`${TOKEN_ID}-error`"
				role="alert"
				class="flex items-start gap-1.5 text-sm text-red-700 dark:text-red-400"
			>
				<UIcon
					name="i-lucide-circle-alert"
					class="mt-0.5 size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>{{ props.error }}</span>
			</p>
		</div>
		<div>
			<UButton
				type="submit"
				:loading="props.busy"
				:disabled="!canSubmit"
			>
				{{ props.busy ? 'Checking Token' : 'Check This Token' }}
			</UButton>
		</div>
	</form>
</template>
