<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { ORG_ROLE_LABELS, type InviteView } from '~/shared/members';
import { type OrgRole } from '~/shared/permissions';
import { useMembersStore } from '~/stores/members';

const props = defineProps<{ orgId: string; invites: InviteView[]; canManage: boolean }>();

const store = useMembersStore();
const error = ref<string | null>(null);
const busy = ref<string | null>(null);

const expires = (at: string) => new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });

async function act(id: string, run: () => Promise<void>): Promise<void> {
	error.value = null;
	busy.value = id;
	try {
		await run();
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = null;
	}
}

const roleLabel = (role: OrgRole) => ORG_ROLE_LABELS[role];
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
			aria-label="Invitations"
		>
			<table class="w-full text-left text-sm">
				<thead class="bg-elevated text-muted">
					<tr>
						<th
							scope="col"
							class="px-3 py-2 font-medium"
						>
							Email
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
							Expires
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
						v-for="invite in invites"
						:key="invite.id"
					>
						<th
							scope="row"
							class="px-3 py-2 font-medium wrap-break-word text-highlighted"
						>
							{{ invite.email }}
						</th>
						<td class="px-3 py-2 text-default">{{ roleLabel(invite.role) }}</td>
						<td class="px-3 py-2 text-default">{{ expires(invite.expiresAt) }}</td>
						<td class="px-3 py-2">
							<div
								v-if="canManage"
								class="flex justify-end gap-2"
							>
								<UButton
									color="neutral"
									variant="outline"
									size="sm"
									:loading="busy === invite.id"
									:aria-label="`Send the invitation to ${invite.email} again`"
									@click="
										act(invite.id, () => store.resendInvite(orgId, invite.id))
									"
									>Resend</UButton
								>
								<UButton
									color="error"
									variant="outline"
									size="sm"
									:aria-label="`Revoke the invitation to ${invite.email}`"
									@click="
										act(invite.id, () => store.revokeInvite(orgId, invite.id))
									"
									>Revoke</UButton
								>
							</div>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
