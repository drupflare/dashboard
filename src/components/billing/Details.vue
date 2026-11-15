<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { useBillingStore } from '~/stores/billing';

const props = defineProps<{
	orgId: string;
	// the parts the server said it lacks: name, email, country
	missing: string[];
}>();

const emit = defineEmits<{ saved: []; cancel: [] }>();

const billing = useBillingStore();

const name = ref('');
const email = ref('');
const country = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

async function save() {
	error.value = null;
	if (!/^[A-Za-z]{2}$/.test(country.value.trim())) {
		error.value = 'Enter the two-letter country code, like US or GB.';
		return;
	}
	busy.value = true;
	try {
		await billing.saveDetails(props.orgId, {
			name: name.value,
			email: email.value,
			country: country.value.trim().toUpperCase()
		});
		emit('saved');
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<form
		class="flex max-w-md flex-col gap-4 rounded-lg border border-default p-4"
		@submit.prevent="save()"
	>
		<div class="flex flex-col gap-1">
			<h3 class="font-semibold text-highlighted">Add Your Billing Details First</h3>
			<p class="text-sm text-muted">
				We need a billing contact and country before you can buy. The payment page asks for
				the full address and keeps these in step.
			</p>
		</div>
		<UiField
			id="billing-name"
			label="Contact Name"
			v-slot="{ describedBy }"
		>
			<input
				id="billing-name"
				v-model="name"
				type="text"
				autocomplete="name"
				required
				:class="inputClass"
				:aria-describedby="describedBy"
			/>
		</UiField>
		<UiField
			id="billing-email"
			label="Contact Email"
			v-slot="{ describedBy }"
		>
			<input
				id="billing-email"
				v-model="email"
				type="email"
				autocomplete="email"
				required
				:class="inputClass"
				:aria-describedby="describedBy"
			/>
		</UiField>
		<UiField
			id="billing-country"
			label="Country Code"
			:error="error"
			v-slot="{ describedBy }"
		>
			<input
				id="billing-country"
				v-model="country"
				type="text"
				autocomplete="country"
				maxlength="2"
				required
				:class="inputClass"
				:aria-invalid="error ? 'true' : undefined"
				:aria-describedby="describedBy"
			/>
		</UiField>
		<div class="flex gap-3">
			<UButton
				type="submit"
				:loading="busy"
				>Save and Continue</UButton
			>
			<UButton
				type="button"
				color="neutral"
				variant="outline"
				@click="emit('cancel')"
				>Cancel</UButton
			>
		</div>
	</form>
</template>
