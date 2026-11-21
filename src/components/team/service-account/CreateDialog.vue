<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { SERVICE_ACCOUNT_MAX_DAYS, type ServiceAccountView } from '~/shared/service-accounts';
import { useServiceAccountsStore } from '~/stores/service-accounts';

const props = defineProps<{
	orgId: string;
	owners: { label: string; value: string }[];
	departments: { label: string; value: string }[];
}>();
const emit = defineEmits<{ created: [account: ServiceAccountView] }>();

const store = useServiceAccountsStore();

// the select refuses an empty value, so "nobody" has a name of its own
const NONE = 'none';
const open = ref(false);
const trigger = useTemplateRef<{ $el: HTMLElement }>('trigger');
const name = ref('');
const owner = ref(NONE);
const department = ref(NONE);
const days = ref<number | null>(90);
const busy = ref(false);
const error = ref<string | null>(null);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

function show(): void {
	name.value = '';
	owner.value = NONE;
	department.value = NONE;
	days.value = 90;
	error.value = null;
	open.value = true;
}

watch(open, (value) => {
	if (!value) void nextTick(() => trigger.value?.$el.focus());
});

async function submit(): Promise<void> {
	error.value = null;
	if (name.value.trim() === '') {
		error.value = 'Enter a name so people can tell this account apart.';
		return;
	}
	const count = days.value;
	if (
		count === null ||
		!Number.isInteger(count) ||
		count < 1 ||
		count > SERVICE_ACCOUNT_MAX_DAYS
	) {
		error.value = `Enter a whole number of days from 1 to ${SERVICE_ACCOUNT_MAX_DAYS}.`;
		return;
	}
	busy.value = true;
	try {
		const created = await store.create(props.orgId, {
			name: name.value.trim(),
			expiresInDays: count,
			...(owner.value === NONE ? {} : { ownerUserId: owner.value }),
			...(department.value === NONE ? {} : { departmentId: department.value })
		});
		open.value = false;
		emit('created', created);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div>
		<UButton
			ref="trigger"
			icon="i-lucide-plus"
			@click="show()"
			>Create a Service Account</UButton
		>
		<UModal
			v-model:open="open"
			title="Create a Service Account"
			description="A service account holds keys and has no sign-in. It needs an owner and an expiry."
		>
			<template #body>
				<form
					class="flex flex-col gap-4"
					@submit.prevent="submit()"
				>
					<UiField
						id="service-account-name"
						label="Name"
						v-slot="{ describedBy }"
					>
						<input
							id="service-account-name"
							v-model="name"
							type="text"
							maxlength="80"
							autocomplete="off"
							aria-required="true"
							:class="inputClass"
							:aria-describedby="describedBy"
						/>
					</UiField>
					<UFormField
						label="Owner"
						help="Its keys never hold more than the owner does, and stop if the owner leaves."
					>
						<USelect
							v-model="owner"
							:items="[{ label: 'Me', value: NONE }, ...owners]"
							aria-label="Owner"
							class="w-full"
						/>
					</UFormField>
					<UFormField
						v-if="departments.length > 0"
						label="Department"
					>
						<USelect
							v-model="department"
							:items="[
								{ label: 'None (Whole Organization)', value: NONE },
								...departments
							]"
							aria-label="Department"
							class="w-full"
						/>
					</UFormField>
					<UiField
						id="service-account-days"
						label="Expires After (Days)"
						:hint="`At most ${SERVICE_ACCOUNT_MAX_DAYS} days. Make a new one to renew.`"
						v-slot="{ describedBy }"
					>
						<input
							id="service-account-days"
							v-model.number="days"
							type="number"
							min="1"
							:max="SERVICE_ACCOUNT_MAX_DAYS"
							step="1"
							aria-required="true"
							:class="inputClass"
							:aria-describedby="describedBy"
						/>
					</UiField>
					<p
						v-if="error"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ error }}
					</p>
					<div class="flex gap-3">
						<UButton
							type="submit"
							:loading="busy"
							>Create</UButton
						>
						<UButton
							type="button"
							color="neutral"
							variant="outline"
							@click="open = false"
							>Cancel</UButton
						>
					</div>
				</form>
			</template>
		</UModal>
	</div>
</template>
