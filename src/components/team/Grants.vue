<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import {
	SITE_GRANT_EXPIRY_PRESETS,
	SITE_ROLE_LABELS,
	sitePreviewLine,
	type SiteGrantExpiry,
	type SiteGrantView
} from '~/shared/members';
import { SITE_ROLES, type SiteRole } from '~/shared/permissions';
import { useMembersStore } from '~/stores/members';

const props = defineProps<{
	orgId: string;
	siteId: string;
	grants: SiteGrantView[];
	canManage: boolean;
}>();

const store = useMembersStore();

const EXPIRY_LABELS: Record<SiteGrantExpiry, string> = {
	never: 'Never',
	'30d': '30 Days',
	'90d': '90 Days',
	'180d': '180 Days',
	'365d': '1 Year'
};
const expiryItems = SITE_GRANT_EXPIRY_PRESETS.map((value) => ({
	label: EXPIRY_LABELS[value],
	value
}));
const roleItems = SITE_ROLES.map((value) => ({ label: SITE_ROLE_LABELS[value], value }));
const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const email = ref('');
const role = ref<SiteRole>('viewer');
const expiry = ref<SiteGrantExpiry>('never');
const error = ref<string | null>(null);
const busy = ref(false);

const preview = computed(() => sitePreviewLine(role.value));

const expires = (at: string | null) =>
	at === null ? 'Never' : new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });

async function add(): Promise<void> {
	error.value = null;
	const address = email.value.trim();
	if (address === '') {
		error.value = 'Enter the email address of the person to add.';
		return;
	}
	busy.value = true;
	try {
		await store.grant(props.orgId, props.siteId, {
			email: address,
			role: role.value,
			expiry: expiry.value
		});
		email.value = '';
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}

async function run(action: () => Promise<void>): Promise<void> {
	error.value = null;
	try {
		await action();
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	}
}
</script>

<template>
	<div class="flex flex-col gap-6">
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
			aria-label="Grants"
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
							Site Role
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
						v-for="grant in grants"
						:key="grant.id"
					>
						<th
							scope="row"
							class="px-3 py-2 font-medium wrap-break-word text-highlighted"
						>
							{{ grant.displayName ?? grant.email }}
							<span class="block text-xs font-normal text-muted">{{
								grant.inOrganization
									? 'In this organization'
									: 'Outside the organization'
							}}</span>
						</th>
						<td class="px-3 py-2">
							<USelect
								v-if="canManage"
								:model-value="grant.role"
								:items="roleItems"
								:aria-label="`Site role for ${grant.displayName ?? grant.email}`"
								class="w-full"
								@update:model-value="
									run(() =>
										store.changeGrant(orgId, siteId, grant.id, {
											role: $event as SiteRole,
											expiry: 'keep'
										})
									)
								"
							/>
							<span
								v-else
								class="text-default"
								>{{ SITE_ROLE_LABELS[grant.role] }}</span
							>
						</td>
						<td class="px-3 py-2 text-default">{{ expires(grant.expiresAt) }}</td>
						<td class="px-3 py-2 text-right">
							<UButton
								v-if="canManage"
								color="error"
								variant="outline"
								size="sm"
								:aria-label="`Remove site access for ${grant.displayName ?? grant.email}`"
								@click="run(() => store.revokeGrant(orgId, siteId, grant.id))"
								>Remove</UButton
							>
						</td>
					</tr>
				</tbody>
			</table>
		</div>

		<form
			v-if="canManage"
			class="flex flex-col gap-4 rounded-lg border border-default p-4"
			@submit.prevent="add()"
		>
			<h3 class="text-base font-semibold text-highlighted">Add a Collaborator</h3>
			<UiField
				id="grant-email"
				label="Email"
				hint="The person needs an account before you can add them."
				v-slot="{ describedBy }"
			>
				<input
					id="grant-email"
					v-model="email"
					type="email"
					autocomplete="off"
					aria-required="true"
					:class="inputClass"
					:aria-describedby="describedBy"
				/>
			</UiField>
			<UFormField label="Site Role">
				<USelect
					v-model="role"
					:items="roleItems"
					class="w-full"
				/>
			</UFormField>
			<p
				class="text-sm text-default"
				aria-live="polite"
			>
				{{ preview }}.
			</p>
			<UFormField label="Expires After">
				<USelect
					v-model="expiry"
					:items="expiryItems"
					class="w-full"
				/>
			</UFormField>
			<div>
				<UButton
					type="submit"
					:loading="busy"
					>Add Collaborator</UButton
				>
			</div>
		</form>
	</div>
</template>
