<script setup lang="ts">
import { useContactsStore } from '~/stores/contacts';

definePageMeta({ layout: 'public' });
useHead({ title: 'Confirm a Contact' });

const route = useRoute();
const contacts = useContactsStore();

const token = computed(() => (typeof route.query.token === 'string' ? route.query.token : ''));
const outcome = ref<'pending' | 'verified' | 'failed'>('pending');

onMounted(async () => {
	if (token.value.length < 20) {
		outcome.value = 'failed';
		return;
	}
	outcome.value = (await contacts.confirm(token.value)) ? 'verified' : 'failed';
});
</script>

<template>
	<div class="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-16 sm:px-6">
		<h1 class="text-2xl font-bold text-highlighted">Confirm a Contact</h1>
		<p
			v-if="outcome === 'pending'"
			role="status"
			class="text-default"
		>
			Checking the link
		</p>
		<p
			v-else-if="outcome === 'verified'"
			role="status"
			class="text-default"
		>
			This address is confirmed. You can close this page.
		</p>
		<p
			v-else
			role="alert"
			class="text-default"
		>
			This link is no longer valid. Ask the organisation to send a new one from its contacts
			page.
		</p>
	</div>
</template>
