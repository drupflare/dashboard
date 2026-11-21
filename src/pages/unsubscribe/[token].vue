<script setup lang="ts">
import { useNotificationPreferencesStore } from '~/stores/notification-preferences';

definePageMeta({ layout: 'public' });
useHead({ title: 'Stop These Emails' });

const route = useRoute();
const preferences = useNotificationPreferencesStore();

const token = computed(() => (typeof route.params.token === 'string' ? route.params.token : ''));
const outcome = ref<'ask' | 'working' | 'done' | 'failed'>('ask');

// the page asks first, so a mail scanner that opens the link does not unsubscribe anyone
async function confirm() {
	outcome.value = 'working';
	outcome.value = (await preferences.unsubscribe(token.value)) ? 'done' : 'failed';
}
</script>

<template>
	<div class="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-16 sm:px-6">
		<h1 class="text-2xl font-bold text-highlighted">Stop These Emails</h1>
		<template v-if="outcome === 'ask' || outcome === 'working'">
			<p class="text-default">
				Confirm that you want to stop this kind of email. It stops only the one kind that
				sent the message. Emails you need to keep your account working, such as sign-in
				codes and security alerts, are not affected.
			</p>
			<UButton
				class="self-start"
				:loading="outcome === 'working'"
				:disabled="token.length < 20"
				@click="confirm"
			>
				Stop These Emails
			</UButton>
		</template>
		<p
			v-else-if="outcome === 'done'"
			role="status"
			class="text-default"
		>
			Done. You will not get this kind of email any more. You can turn it back on from
			Notifications in your account settings.
		</p>
		<p
			v-else
			role="alert"
			class="text-default"
		>
			This link is no longer valid. Sign in and open Notifications in your account settings to
			change your emails.
		</p>
	</div>
</template>
