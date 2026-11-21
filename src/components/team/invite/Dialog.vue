<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { assignableRoles, INVITE_TTL_DAYS, ORG_ROLE_LABELS } from '~/shared/members';
import type { OrgRole } from '~/shared/permissions';
import { useMembersStore } from '~/stores/members';

const props = defineProps<{ orgId: string; actorRole: OrgRole }>();
const emit = defineEmits<{ invited: [] }>();

const members = useMembersStore();

const open = ref(false);
const trigger = useTemplateRef<{ $el: HTMLElement }>('trigger');
const email = ref('');
const role = ref<OrgRole>('viewer');
const busy = ref(false);
const error = ref<string | null>(null);
const sent = ref<string | null>(null);

const roles = computed(() => assignableRoles(props.actorRole));
const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

function show(): void {
	email.value = '';
	role.value = roles.value[0] ?? 'viewer';
	error.value = null;
	sent.value = null;
	open.value = true;
}

watch(open, (value) => {
	if (!value) void nextTick(() => trigger.value?.$el.focus());
});

async function submit(): Promise<void> {
	error.value = null;
	const address = email.value.trim();
	if (address === '') {
		error.value = 'Enter the email address of the person to invite.';
		return;
	}
	const chosen = role.value;
	if (chosen === 'owner') {
		error.value = 'An owner cannot be invited. Pick another role.';
		return;
	}
	busy.value = true;
	try {
		await members.invite(props.orgId, { email: address, role: chosen });
		sent.value = address;
		emit('invited');
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
			icon="i-lucide-user-plus"
			@click="show()"
			>Invite a Member</UButton
		>
		<UModal
			v-model:open="open"
			title="Invite a Member"
			:description="`The link in the email works once and expires after ${INVITE_TTL_DAYS} days.`"
		>
			<template #body>
				<div
					v-if="sent"
					class="flex flex-col gap-4"
				>
					<p class="text-sm text-default">The invitation was sent to {{ sent }}.</p>
					<UButton
						color="neutral"
						variant="outline"
						@click="open = false"
						>Close</UButton
					>
				</div>
				<form
					v-else
					class="flex flex-col gap-4"
					@submit.prevent="submit()"
				>
					<UiField
						id="invite-email"
						label="Email"
						v-slot="{ describedBy }"
					>
						<input
							id="invite-email"
							v-model="email"
							type="email"
							autocomplete="off"
							aria-required="true"
							:class="inputClass"
							:aria-describedby="describedBy"
						/>
					</UiField>

					<UFormField label="Role">
						<TeamRolePicker
							v-model="role"
							:roles="roles"
							label="Role"
						/>
					</UFormField>

					<section class="flex flex-col gap-2">
						<h3 class="text-sm font-medium text-highlighted">
							What {{ ORG_ROLE_LABELS[role] }} Can Do
						</h3>
						<TeamPermissionMatrix :role="role" />
					</section>

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
							>Send Invitation</UButton
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
