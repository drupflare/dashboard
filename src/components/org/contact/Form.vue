<script setup lang="ts">
import type { ContactBody, ContactRole, ContactView } from '~/shared/contacts';
import { CONTACT_ROLE_LABELS } from '~/shared/contacts';

const props = defineProps<{
	role: ContactRole;
	current: ContactView | undefined;
	saving: boolean;
}>();

const emit = defineEmits<{ save: [body: ContactBody] }>();

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const form = reactive({
	name: props.current?.name ?? '',
	email: props.current?.email ?? '',
	notifyOn: props.current?.notifyOn ?? false
});

watch(
	() => props.current,
	(next) => {
		form.name = next?.name ?? '';
		form.email = next?.email ?? '';
		form.notifyOn = next?.notifyOn ?? false;
	}
);

function submit() {
	emit('save', { name: form.name, email: form.email, notifyOn: form.notifyOn });
}
</script>

<template>
	<form
		class="flex flex-col gap-4"
		@submit.prevent="submit"
	>
		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium text-highlighted">Name</span>
			<input
				v-model="form.name"
				:class="inputClass"
				maxlength="120"
				required
				:aria-label="`${CONTACT_ROLE_LABELS[role]} Contact Name`"
			/>
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium text-highlighted">Email</span>
			<input
				v-model="form.email"
				type="email"
				:class="inputClass"
				maxlength="254"
				required
			/>
		</label>
		<label class="flex items-start gap-3">
			<input
				v-model="form.notifyOn"
				type="checkbox"
				class="mt-1"
			/>
			<span class="flex flex-col gap-1">
				<span class="text-sm font-medium text-highlighted">Send Operational Notices</span>
				<span class="text-sm text-muted">
					Allows operational mail to this address after it is confirmed. Only the test
					notification uses this setting today.
				</span>
			</span>
		</label>
		<UButton
			type="submit"
			:loading="saving"
			class="self-start"
			>Save Contact</UButton
		>
	</form>
</template>
