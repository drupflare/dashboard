<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import type { TransferView } from '~/shared/agency';
import { orgRoleHolds } from '~/shared/navigation';
import { isOrgRole } from '~/shared/permissions';
import { useOrgStore } from '~/stores/org';
import { useTransfersStore } from '~/stores/transfers';

const props = defineProps<{
	orgId: string;
	siteId: string;
	siteName: string;
}>();

const org = useOrgStore();
const transfers = useTransfersStore();

const OPEN: TransferView['state'][] = ['proposed', 'accepted', 'completing', 'failed'];

const pending = computed(
	() =>
		transfers.lists
			.get(props.orgId)
			?.data?.outgoing.find((t) => t.siteId === props.siteId && OPEN.includes(t.state)) ??
		null
);

// the receiving owner completes the move; this person sees Complete only when they can accept there too
const canComplete = computed(() => {
	const current = pending.value;
	if (current === null || !['accepted', 'failed'].includes(current.state)) return false;
	const role = org.items?.find((o) => o.id === current.toOrganizationId)?.role;
	return orgRoleHolds(isOrgRole(role) ? role : null, 'transfer.accept');
});

const open = ref(false);
const receiver = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const formError = ref<string | null>(null);
const needsStepUp = ref(false);

onMounted(() => {
	void transfers.load(props.orgId);
});

async function propose(): Promise<void> {
	const to = receiver.value.trim();
	if (!to) return;
	formError.value = null;
	busy.value = true;
	try {
		await transfers.propose(props.orgId, props.siteId, { toOrganizationId: to });
		open.value = false;
		receiver.value = '';
		await transfers.reload(props.orgId);
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { requires?: string } | null;
		if (details?.requires === 'step-up') needsStepUp.value = true;
		else formError.value = failure.message;
	} finally {
		busy.value = false;
	}
}

async function stepUpDone(): Promise<void> {
	needsStepUp.value = false;
	await propose();
}

async function cancel(id: string): Promise<void> {
	error.value = null;
	try {
		await transfers.cancel(props.orgId, props.siteId, id);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	}
}

async function complete(transfer: TransferView): Promise<void> {
	error.value = null;
	try {
		await transfers.complete(transfer.toOrganizationId, transfer.id);
		await transfers.reload(props.orgId);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	}
}
</script>

<template>
	<section class="flex max-w-4xl flex-col gap-4">
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-semibold text-highlighted">Site Transfer</h2>
			<p class="max-w-prose text-sm text-muted">
				Move this site to another organization. The site stays here until the receiving
				owner accepts and completes the move.
			</p>
		</div>

		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>

		<template v-if="pending">
			<AgencyTransferFlow
				:transfer="pending"
				side="outgoing"
				:can-answer="false"
				:can-cancel="true"
				:can-complete="false"
				@cancel="cancel(pending.id)"
			/>
			<div v-if="canComplete">
				<UButton @click="complete(pending)">
					{{ pending.state === 'failed' ? 'Try Again' : 'Complete Transfer' }}
				</UButton>
			</div>
		</template>

		<div v-else>
			<UButton
				color="neutral"
				variant="outline"
				icon="i-lucide-arrow-right-left"
				@click="open = true"
			>
				Transfer This Site
			</UButton>
		</div>

		<UModal
			v-model:open="open"
			title="Transfer This Site"
			:description="`Propose that ${siteName} moves to another organization.`"
		>
			<template #body>
				<AccountStepUp
					v-if="needsStepUp"
					@done="stepUpDone()"
					@cancel="needsStepUp = false"
				/>
				<form
					v-else
					class="flex flex-col gap-4"
					@submit.prevent="propose()"
				>
					<UiField
						id="transfer-receiver"
						label="Receiving Organization ID"
						hint="The ID of the organization that will receive the site."
						:error="formError"
					>
						<template #default="{ describedBy }">
							<UInput
								id="transfer-receiver"
								v-model="receiver"
								class="w-full"
								:aria-describedby="describedBy"
								autocomplete="off"
							/>
						</template>
					</UiField>
					<div class="flex justify-end gap-2">
						<UButton
							color="neutral"
							variant="outline"
							@click="open = false"
						>
							Cancel
						</UButton>
						<UButton
							type="submit"
							:loading="busy"
							:disabled="receiver.trim() === ''"
						>
							Propose Transfer
						</UButton>
					</div>
				</form>
			</template>
		</UModal>
	</section>
</template>
