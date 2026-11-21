<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import {
	assignableRoles,
	canManageMember,
	ORG_ROLE_LABELS,
	type MemberView
} from '~/shared/members';
import { ORG_ROLE_ACTIONS, ORG_ROLES, type OrgRole } from '~/shared/permissions';
import { useMembersStore } from '~/stores/members';

const props = defineProps<{
	orgId: string;
	actorRole: OrgRole;
	members: MemberView[];
	selfUserId?: string | null;
}>();

const emit = defineEmits<{ offboard: [member: MemberView] }>();
const store = useMembersStore();

const error = ref<string | null>(null);
const removing = ref<MemberView | null>(null);
const removeOpen = ref(false);
const busy = ref(false);

const joined = (at: string) => new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });

// the server decides; this only hides controls a person cannot use
const editable = (member: MemberView) => canManageMember(props.actorRole, member.role);

const offboardable = (member: MemberView) =>
	removable(member) && member.userId !== props.selfUserId;

// canManageMember compares role actions only, so a viewer would see remove on another viewer
const removable = (member: MemberView) =>
	ORG_ROLE_ACTIONS[props.actorRole].includes('member.remove') && editable(member);

const rolePickable = (member: MemberView) =>
	ORG_ROLE_ACTIONS[props.actorRole].includes('member.update') && editable(member);

function rolesFor(member: MemberView): OrgRole[] {
	const offered = assignableRoles(props.actorRole);
	return ORG_ROLES.filter((role) => role === member.role || offered.includes(role));
}

async function setRole(member: MemberView, role: OrgRole): Promise<void> {
	error.value = null;
	try {
		await store.changeRole(props.orgId, member.id, { role });
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	}
}

function askRemove(member: MemberView): void {
	error.value = null;
	removing.value = member;
	removeOpen.value = true;
}

async function remove(): Promise<void> {
	if (!removing.value) return;
	busy.value = true;
	try {
		await store.removeMember(props.orgId, removing.value.id);
		removeOpen.value = false;
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}

const nameOf = (member: MemberView) => member.displayName ?? member.email;
</script>

<template>
	<div class="flex flex-col gap-3">
		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>
		<div
			class="overflow-x-auto rounded-lg border border-default"
			tabindex="0"
			role="region"
			aria-label="Members"
		>
			<table class="w-full text-left text-sm">
				<thead class="bg-elevated text-muted">
					<tr>
						<th
							scope="col"
							class="px-3 py-2 font-medium"
						>
							Person
						</th>
						<th
							scope="col"
							class="px-3 py-2 font-medium"
						>
							Role
						</th>
						<th
							scope="col"
							class="px-3 py-2 font-medium"
						>
							Joined
						</th>
						<th
							scope="col"
							class="px-3 py-2 font-medium"
						>
							<span class="sr-only">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-default">
					<tr
						v-for="member in members"
						:key="member.id"
					>
						<th
							scope="row"
							class="px-3 py-2 font-medium wrap-break-word text-highlighted"
						>
							{{ nameOf(member) }}
							<span
								v-if="member.displayName"
								class="block text-xs font-normal text-muted"
								>{{ member.email }}</span
							>
						</th>
						<td class="px-3 py-2">
							<TeamRolePicker
								v-if="rolePickable(member)"
								:model-value="member.role"
								:roles="rolesFor(member)"
								:label="`Role for ${nameOf(member)}`"
								@update:model-value="setRole(member, $event)"
							/>
							<span
								v-else
								class="text-default"
								>{{ ORG_ROLE_LABELS[member.role] }}</span
							>
						</td>
						<td class="px-3 py-2 text-default">{{ joined(member.joinedAt) }}</td>
						<td class="px-3 py-2 text-right">
							<UButton
								v-if="offboardable(member)"
								color="neutral"
								variant="outline"
								size="sm"
								icon="i-lucide-user-x"
								:aria-label="`Offboard ${nameOf(member)}`"
								@click="emit('offboard', member)"
								>Offboard</UButton
							>
							<UButton
								v-if="removable(member)"
								color="error"
								variant="outline"
								size="sm"
								icon="i-lucide-user-minus"
								:aria-label="`Remove ${nameOf(member)}`"
								@click="askRemove(member)"
								>Remove</UButton
							>
						</td>
					</tr>
				</tbody>
			</table>
		</div>

		<UModal
			v-model:open="removeOpen"
			title="Remove This Member"
			:description="removing ? `Remove ${nameOf(removing)} from the organization.` : ''"
		>
			<template #body>
				<div
					v-if="removing"
					class="flex flex-col gap-4"
				>
					<p class="text-sm text-default">
						They lose access to this organization and its sites at once. Their past
						actions stay in the audit log.
					</p>
					<UiConfirmTyped
						:expected="nameOf(removing)"
						:label="`Type ${nameOf(removing)} to confirm`"
						action="Remove Member"
						:busy="busy"
						@confirm="remove()"
						@cancel="removeOpen = false"
					/>
				</div>
			</template>
		</UModal>
	</div>
</template>
