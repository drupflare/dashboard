<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { KEY_SCOPE_COPY } from '~/shared/api-keys';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { SERVICE_ACCOUNT_STATE_LABEL, type ServiceAccountView } from '~/shared/service-accounts';
import { useDepartmentsStore } from '~/stores/departments';
import { useMembersStore } from '~/stores/members';
import { useOrgStore } from '~/stores/org';
import { useServiceAccountsStore } from '~/stores/service-accounts';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Service Accounts' });

const session = useSessionStore();
const org = useOrgStore();
const store = useServiceAccountsStore();
const members = useMembersStore();
const departments = useDepartmentsStore();

const orgId = computed(() => org.current?.id ?? null);
const actions = computed<readonly string[]>(() => {
	const role = org.current?.role;
	return isOrgRole(role) ? ORG_ROLE_ACTIONS[role] : [];
});
const canManage = computed(() => actions.value.includes('service-account.manage'));
const canIssue = computed(() => actions.value.includes('key.create'));
const offered = computed(() => actions.value.filter((action) => action in KEY_SCOPE_COPY));

const list = computed(() => (orgId.value ? store.accounts.get(orgId.value) : undefined));
const rows = computed(() => list.value?.items ?? []);

const owners = computed(
	() =>
		(orgId.value ? members.members.get(orgId.value)?.items : undefined)?.map((member) => ({
			label: member.displayName ?? member.email,
			value: member.userId
		})) ?? []
);
const departmentChoices = computed(
	() =>
		(orgId.value ? departments.departments.get(orgId.value)?.items : undefined)?.map((d) => ({
			label: d.name,
			value: d.id
		})) ?? []
);
const departmentName = (id: string | null) =>
	id === null
		? 'Whole Organization'
		: (departmentChoices.value.find((d) => d.value === id)?.label ?? 'Removed');

const view = computed(() => {
	if (session.me === undefined && session.error) return 'session-error';
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (org.current && !canManage.value) return 'no-access';
	if (list.value === null) return 'no-org';
	if (!list.value || (list.value.status === 'loading' && rows.value.length === 0))
		return 'loading';
	if (rows.value.length === 0 && list.value.status === 'error') return 'error';
	if (rows.value.length === 0) return 'empty';
	return 'list';
});

function loadAll(id: string) {
	if (!canManage.value) return;
	void store.loadAccounts(id);
	void members.loadMembers(id);
	void departments.loadDepartments(id);
}

onMounted(() => {
	if (orgId.value) loadAll(orgId.value);
});

watch(orgId, (id) => {
	if (id) loadAll(id);
});

const day = (at: string | null) =>
	at === null ? 'Never' : new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });

const opened = ref<string | null>(null);
const keys = computed(() =>
	orgId.value && opened.value ? store.keys.get(`${orgId.value}/${opened.value}`) : undefined
);

function toggleKeys(account: ServiceAccountView): void {
	if (!orgId.value) return;
	if (opened.value === account.id) {
		opened.value = null;
		return;
	}
	opened.value = account.id;
	void store.loadKeys(orgId.value, account.id);
}

const disabling = ref<ServiceAccountView | null>(null);
const disableOpen = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

function askDisable(account: ServiceAccountView): void {
	error.value = null;
	disabling.value = account;
	disableOpen.value = true;
}

async function disable(): Promise<void> {
	if (!disabling.value || !orgId.value) return;
	busy.value = true;
	try {
		await store.disable(orgId.value, disabling.value.id);
		disableOpen.value = false;
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}

function reload() {
	if (orgId.value) void store.fetchAccounts(orgId.value);
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Service Accounts"
				text="Accounts for scripts and tools. They have no sign-in, only keys, and every one has an owner and an expiry."
			>
				<TeamServiceAccountCreateDialog
					v-if="orgId && canManage"
					:org-id="orgId"
					:owners="owners"
					:departments="departmentChoices"
				/>
			</UiPageHeader>

			<UiErrorState
				v-if="view === 'session-error'"
				title="Could Not Load Your Account"
				:text="session.error?.message"
				:request-id="session.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="session.load()"
					>Try Again</UButton
				>
			</UiErrorState>
			<UiErrorState
				v-else-if="view === 'org-error'"
				title="Could Not Load Organizations"
				:text="org.error?.message"
				:request-id="org.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="org.load()"
					>Try Again</UButton
				>
			</UiErrorState>
			<UiEmptyState
				v-else-if="view === 'no-org'"
				icon="i-lucide-building-2"
				title="No Organization Found"
				text="Sign out and sign in again to set up your organization."
			/>
			<UiEmptyState
				v-else-if="view === 'no-access'"
				icon="i-lucide-lock"
				title="Owners and Admins Only"
				text="Ask an organization owner or admin to manage service accounts."
			/>
			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading service accounts"
			/>
			<UiErrorState
				v-else-if="view === 'error'"
				title="Could Not Load Service Accounts"
				:text="list?.error?.message"
				:request-id="list?.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="reload"
					>Try Again</UButton
				>
			</UiErrorState>
			<UiEmptyState
				v-else-if="view === 'empty'"
				icon="i-lucide-bot"
				title="No Service Accounts Yet"
				text="Create one when a script or tool needs access that should not depend on a person's sign-in."
			/>

			<div
				v-else
				class="flex flex-col gap-3"
			>
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
					aria-label="Service Accounts"
				>
					<table class="w-full text-left text-sm">
						<thead class="bg-elevated text-muted">
							<tr>
								<th
									scope="col"
									class="px-3 py-2 font-medium"
								>
									Account
								</th>
								<th
									scope="col"
									class="px-3 py-2 font-medium"
								>
									Owner
								</th>
								<th
									scope="col"
									class="px-3 py-2 font-medium"
								>
									State
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
									Last Used
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
							<template
								v-for="account in rows"
								:key="account.id"
							>
								<tr>
									<th
										scope="row"
										class="px-3 py-2 font-medium wrap-break-word text-highlighted"
									>
										{{ account.name }}
										<span class="block text-xs font-normal text-muted">{{
											departmentName(account.departmentId)
										}}</span>
									</th>
									<td class="px-3 py-2 text-default">
										{{ account.ownerEmail ?? 'Unknown' }}
									</td>
									<td class="px-3 py-2 text-default">
										{{ SERVICE_ACCOUNT_STATE_LABEL[account.state] }}
									</td>
									<td class="px-3 py-2 text-default">
										{{ day(account.expiresAt) }}
									</td>
									<td class="px-3 py-2 text-default">
										{{ day(account.lastUsedAt) }}
									</td>
									<td class="px-3 py-2">
										<div class="flex flex-wrap justify-end gap-2">
											<UButton
												size="sm"
												color="neutral"
												variant="outline"
												:aria-expanded="opened === account.id"
												:aria-label="`Keys for ${account.name}`"
												@click="toggleKeys(account)"
												>Keys ({{ account.keyCount }})</UButton
											>
											<TeamServiceAccountKeyDialog
												v-if="
													orgId && canIssue && account.state === 'active'
												"
												:org-id="orgId"
												:account-id="account.id"
												:account-name="account.name"
												:offered="offered"
											/>
											<UButton
												v-if="account.state !== 'disabled'"
												size="sm"
												color="error"
												variant="outline"
												:aria-label="`Disable ${account.name}`"
												@click="askDisable(account)"
												>Disable</UButton
											>
										</div>
									</td>
								</tr>
								<tr v-if="opened === account.id">
									<td
										colspan="6"
										class="bg-elevated px-3 py-2"
									>
										<USkeleton
											v-if="!keys || keys.status === 'loading'"
											class="h-6 w-full"
										/>
										<p
											v-else-if="keys.status === 'error'"
											role="alert"
											class="text-sm text-red-700 dark:text-red-400"
										>
											{{ keys.error?.message }}
										</p>
										<p
											v-else-if="keys.items.length === 0"
											class="text-sm text-muted"
										>
											This account has no keys yet.
										</p>
										<ul
											v-else
											class="flex flex-col gap-1 text-sm"
											aria-label="Keys"
										>
											<li
												v-for="key in keys.items"
												:key="key.id"
												class="text-default"
											>
												<span class="font-medium text-highlighted">{{
													key.name
												}}</span>
												<span class="text-muted">
													{{ key.prefix ?? '' }}. Last used
													{{ day(key.lastUsedAt) }}.
													{{
														key.revokedAt
															? 'Revoked.'
															: `Expires ${day(key.expiresAt)}.`
													}}</span
												>
											</li>
										</ul>
									</td>
								</tr>
							</template>
						</tbody>
					</table>
				</div>
			</div>

			<UModal
				v-model:open="disableOpen"
				title="Disable This Service Account"
				:description="
					disabling ? `Turn off ${disabling.name} and revoke every key it holds.` : ''
				"
			>
				<template #body>
					<div
						v-if="disabling"
						class="flex flex-col gap-4"
					>
						<p class="text-sm text-default">
							Anything using its keys stops working at once. You cannot turn the
							account back on. Make a new one if you still need it.
						</p>
						<UiConfirmTyped
							:expected="disabling.name"
							:label="`Type ${disabling.name} to confirm`"
							action="Disable Account"
							:busy="busy"
							@confirm="disable()"
							@cancel="disableOpen = false"
						/>
					</div>
				</template>
			</UModal>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full" />
		</template>
	</ClientOnly>
</template>
