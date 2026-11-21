<script setup lang="ts">
import {
	CONTACT_ROLE_LABELS,
	CONTACT_ROLES,
	type ContactBody,
	type ContactRole,
	type ContactView,
	type TestResult
} from '~/shared/contacts';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { useContactsStore } from '~/stores/contacts';
import { useOrgStore } from '~/stores/org';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Organization Contacts' });

const org = useOrgStore();
const contacts = useContactsStore();

const orgId = computed(() => org.current?.id ?? null);
const role = computed(() => org.current?.role);
const canRead = computed(
	() => isOrgRole(role.value) && ORG_ROLE_ACTIONS[role.value].includes('contact.read')
);
const canManage = computed(
	() => isOrgRole(role.value) && ORG_ROLE_ACTIONS[role.value].includes('contact.manage')
);
const canRecovery = computed(
	() => isOrgRole(role.value) && ORG_ROLE_ACTIONS[role.value].includes('contact.recovery.manage')
);
const list = computed(() => (orgId.value ? contacts.contacts.get(orgId.value) : undefined));

const testResults = reactive<Partial<Record<ContactRole, TestResult>>>({});
const notice = ref<string | null>(null);

onMounted(() => {
	if (orgId.value && canRead.value) void contacts.load(orgId.value);
});

watch(orgId, (id) => {
	if (id && canRead.value) void contacts.load(id);
});

const state = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (org.current && !canRead.value) return 'no-access';
	if (contacts.error && list.value === undefined) return 'error';
	if (list.value === undefined) return 'loading';
	return 'list';
});

const viewOf = (r: ContactRole): ContactView | undefined => list.value?.find((c) => c.role === r);

function allowedToSave(r: ContactRole): boolean {
	return r === 'recovery' ? canRecovery.value : canManage.value;
}

async function save(r: ContactRole, body: ContactBody) {
	if (!orgId.value) return;
	notice.value = null;
	const ok = await contacts.save(orgId.value, r, body);
	if (ok)
		notice.value = `${CONTACT_ROLE_LABELS[r]} contact saved. Confirm the address before a test can send.`;
}

async function sendConfirmation(r: ContactRole) {
	if (!orgId.value) return;
	notice.value = null;
	if (await contacts.verify(orgId.value, r)) {
		notice.value = `A confirmation link was sent to the ${CONTACT_ROLE_LABELS[r].toLowerCase()} contact.`;
	}
}

async function sendTest(r: ContactRole) {
	if (!orgId.value) return;
	const result = await contacts.test(orgId.value, r);
	if (result) testResults[r] = result;
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Organization Contacts"
				text="Name who we contact about your sites: technical, billing, legal and recovery. Each address is confirmed by a link before a test can reach it."
			/>

			<UiErrorState
				v-if="state === 'org-error'"
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
				v-else-if="state === 'no-org'"
				icon="i-lucide-building-2"
				title="No Organization Found"
				text="Sign out and sign in again to set up your organization."
			/>

			<UiEmptyState
				v-else-if="state === 'no-access'"
				icon="i-lucide-lock"
				title="Only Admins Can See Contacts"
				text="Ask an owner or admin of this organization for a contact change."
			/>

			<UiErrorState
				v-else-if="state === 'error'"
				title="Could Not Load the Contacts"
				:text="contacts.error?.message"
				:request-id="contacts.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="orgId && contacts.load(orgId, true)"
					>Try Again</UButton
				>
			</UiErrorState>

			<p
				v-else-if="state === 'loading'"
				role="status"
				class="text-sm text-muted"
			>
				Loading contacts
			</p>

			<template v-else>
				<p
					v-if="notice"
					role="status"
					class="text-sm text-default"
				>
					{{ notice }}
				</p>
				<p
					v-if="contacts.saveError"
					role="alert"
					class="text-sm text-error"
				>
					{{ contacts.saveError.message }}
				</p>

				<section
					v-for="r in CONTACT_ROLES"
					:key="r"
					class="flex flex-col gap-4 rounded-lg border border-default p-4"
					:aria-labelledby="`contact-${r}`"
				>
					<div class="flex flex-col gap-1">
						<h2
							:id="`contact-${r}`"
							class="text-lg font-semibold text-highlighted"
						>
							{{ CONTACT_ROLE_LABELS[r] }} Contact
						</h2>
						<p
							v-if="viewOf(r)"
							class="text-sm text-muted"
						>
							{{ viewOf(r)?.name }}, {{ viewOf(r)?.email }},
							{{ viewOf(r)?.verifiedAt ? 'confirmed' : 'not confirmed yet' }}
						</p>
						<p
							v-else
							class="text-sm text-muted"
						>
							No {{ CONTACT_ROLE_LABELS[r].toLowerCase() }} contact is set.
						</p>
						<p
							v-if="r === 'recovery'"
							class="text-sm text-muted"
						>
							Changing the recovery contact asks you to sign in again first.
						</p>
					</div>

					<template v-if="allowedToSave(r)">
						<OrgContactForm
							:role="r"
							:current="viewOf(r)"
							:saving="contacts.saving"
							@save="(body) => save(r, body)"
						/>
						<div class="flex flex-wrap gap-2">
							<UButton
								v-if="viewOf(r) && !viewOf(r)?.verifiedAt"
								color="neutral"
								@click="sendConfirmation(r)"
								>Send Confirmation</UButton
							>
							<UButton
								v-if="viewOf(r)?.verifiedAt"
								color="neutral"
								@click="sendTest(r)"
								>Send a Test Notification</UButton
							>
						</div>
						<p
							v-if="testResults[r]"
							role="status"
							class="text-sm text-default"
						>
							{{ testResults[r]?.message }}
						</p>
					</template>
				</section>
			</template>
		</div>
	</ClientOnly>
</template>
