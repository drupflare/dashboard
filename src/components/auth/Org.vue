<script setup lang="ts">
import { isSsoFailure, SSO_FAILURES } from '~/shared/sso';

const route = useRoute();
const name = ref('');
const nameError = ref<string | null>(null);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const failure = computed(() => {
	const code = route.query.sso;
	return isSsoFailure(code) ? SSO_FAILURES[code] : null;
});

async function start() {
	const slug = name.value.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
		nameError.value = 'Enter the sign-in name your organization gave you.';
		return;
	}
	nameError.value = null;
	await navigateTo(`/api/v1/auth/sso/${slug}/start`, { external: true });
}
</script>

<template>
	<form
		class="flex flex-col gap-4 border-t border-default pt-6"
		@submit.prevent="start"
	>
		<h2 class="text-lg font-semibold text-highlighted">Sign In With Your Organization</h2>
		<p
			v-if="failure"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ failure }}
		</p>
		<UiField
			id="sso-name"
			label="Organization Sign-In Name"
			hint="Your school or agency gives you this name."
			:error="nameError"
			v-slot="{ describedBy }"
		>
			<input
				id="sso-name"
				v-model="name"
				type="text"
				name="organization"
				autocomplete="organization"
				autocapitalize="none"
				spellcheck="false"
				:class="inputClass"
				:aria-invalid="nameError ? 'true' : undefined"
				:aria-describedby="describedBy"
			/>
		</UiField>
		<UButton
			type="submit"
			color="neutral"
			variant="outline"
			block
			>Continue</UButton
		>
	</form>
</template>
