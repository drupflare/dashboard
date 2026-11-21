<script setup lang="ts">
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { SSO_CLAIM_ROLES, SSO_DEFAULT_GROUP_CLAIM, type SsoRole } from '~/shared/sso';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { useSsoStore } from '~/stores/sso';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Organization Sign-In' });

const session = useSessionStore();
const org = useOrgStore();
const sso = useSsoStore();

const orgId = computed(() => org.current?.id ?? null);
const canManage = computed(() => {
	const role = org.current?.role;
	return isOrgRole(role) && ORG_ROLE_ACTIONS[role].includes('org.sso.manage');
});
const view = computed(() => (orgId.value ? sso.views.get(orgId.value) : undefined));

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const roleLabels: Record<SsoRole, string> = {
	viewer: 'Viewer',
	billing: 'Billing',
	developer: 'Developer',
	admin: 'Admin'
};

const form = reactive({
	slug: '',
	issuer: '',
	clientId: '',
	clientSecret: '',
	domains: '',
	groupClaim: SSO_DEFAULT_GROUP_CLAIM,
	defaultRole: 'viewer' as SsoRole,
	rows: [] as { group: string; role: SsoRole }[],
	enabled: false
});
const copied = ref(false);

function fill() {
	const current = view.value;
	if (!current) return;
	form.slug = current.slug ?? '';
	form.issuer = current.issuer ?? '';
	form.clientId = current.clientId ?? '';
	form.clientSecret = '';
	form.domains = current.allowedDomains.join('\n');
	form.groupClaim = current.groupClaim;
	form.defaultRole = current.defaultRole;
	form.rows = current.roleMap.map((row) => ({ ...row }));
	form.enabled = current.enabled;
}

function load(id: string) {
	if (canManage.value) void sso.load(id).then(fill);
}

onMounted(() => {
	if (orgId.value) load(orgId.value);
});

watch(orgId, (id) => {
	if (id) load(id);
});

const state = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (org.current && !canManage.value) return 'no-access';
	if (sso.error && view.value === undefined) return 'error';
	if (view.value === undefined) return 'loading';
	return 'form';
});

const domainList = () =>
	form.domains
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean);

function body() {
	return {
		slug: form.slug,
		issuer: form.issuer,
		clientId: form.clientId,
		...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
		allowedDomains: domainList(),
		roleMap: form.rows.filter((row) => row.group.trim() !== ''),
		groupClaim: form.groupClaim,
		defaultRole: form.defaultRole,
		enabled: form.enabled
	};
}

async function save() {
	if (!orgId.value) return;
	const saved = await sso.save(orgId.value, body());
	if (saved) fill();
}

async function runTest() {
	if (orgId.value) await sso.test(orgId.value);
}

async function copyAddress() {
	const address = view.value?.redirectUri;
	if (!address) return;
	try {
		await navigator.clipboard.writeText(address);
		copied.value = true;
	} catch {
		copied.value = false;
	}
}

const addRow = () => form.rows.push({ group: '', role: 'viewer' });
const removeRow = (index: number) => form.rows.splice(index, 1);
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Organization Sign-In"
				text="Let people at your school or agency sign in with the account they already have there, using OpenID Connect."
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
				title="Only an Owner Can Change This"
				text="Ask an owner of this organization to set up organization sign-in."
			/>

			<UiErrorState
				v-else-if="state === 'error'"
				title="Could Not Load the Settings"
				:text="sso.error?.message"
				:request-id="sso.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="orgId && sso.load(orgId, true).then(fill)"
					>Try Again</UButton
				>
			</UiErrorState>

			<p
				v-else-if="state === 'loading'"
				role="status"
				class="text-muted"
			>
				Loading the settings.
			</p>

			<form
				v-else
				class="flex max-w-2xl flex-col gap-5"
				@submit.prevent="save"
			>
				<UiField
					id="sso-slug"
					label="Sign-In Name"
					hint="People type this on the sign-in page. Use letters, numbers and hyphens."
				>
					<input
						id="sso-slug"
						v-model="form.slug"
						name="slug"
						required
						:class="inputClass"
					/>
				</UiField>
				<UiField
					id="sso-issuer"
					label="Provider Address"
					hint="The address your identity provider gives as its issuer. It starts with https://."
				>
					<input
						id="sso-issuer"
						v-model="form.issuer"
						name="issuer"
						type="url"
						required
						:class="inputClass"
					/>
				</UiField>
				<UiField
					id="sso-client-id"
					label="Client ID"
				>
					<input
						id="sso-client-id"
						v-model="form.clientId"
						name="clientId"
						required
						autocomplete="off"
						:class="inputClass"
					/>
				</UiField>
				<UiField
					id="sso-client-secret"
					label="Client Secret"
					:hint="
						view?.secretSet
							? 'A secret is stored. Leave this empty to keep it.'
							: 'Drupflare stores it encrypted and never shows it again.'
					"
				>
					<input
						id="sso-client-secret"
						v-model="form.clientSecret"
						name="clientSecret"
						type="password"
						autocomplete="new-password"
						:required="!view?.secretSet"
						:class="inputClass"
					/>
				</UiField>
				<UiField
					id="sso-domains"
					label="Allowed Email Domains"
					hint="One per line. Only these domains can sign in. A subdomain needs its own line."
				>
					<textarea
						id="sso-domains"
						v-model="form.domains"
						name="domains"
						rows="3"
						required
						:class="inputClass"
					/>
				</UiField>

				<fieldset class="flex flex-col gap-3">
					<legend class="text-sm font-medium text-default">Roles From Groups</legend>
					<p class="text-sm text-muted">
						Match a group name from the provider to a role. If a person is in several
						groups, the highest role wins. Owner can never come from a group.
					</p>
					<UiField
						id="sso-group-claim"
						label="Group Field Name"
					>
						<input
							id="sso-group-claim"
							v-model="form.groupClaim"
							name="groupClaim"
							required
							:class="inputClass"
						/>
					</UiField>
					<div
						v-for="(row, index) in form.rows"
						:key="index"
						class="flex flex-wrap items-end gap-2"
					>
						<UiField
							:id="`sso-group-${index}`"
							label="Group"
						>
							<input
								:id="`sso-group-${index}`"
								v-model="row.group"
								name="group"
								:class="inputClass"
							/>
						</UiField>
						<UiField
							:id="`sso-role-${index}`"
							label="Role"
						>
							<select
								:id="`sso-role-${index}`"
								v-model="row.role"
								name="role"
								:class="inputClass"
							>
								<option
									v-for="role in SSO_CLAIM_ROLES"
									:key="role"
									:value="role"
								>
									{{ roleLabels[role] }}
								</option>
							</select>
						</UiField>
						<UButton
							color="neutral"
							variant="ghost"
							@click="removeRow(index)"
							>Remove</UButton
						>
					</div>
					<div>
						<UButton
							color="neutral"
							variant="outline"
							@click="addRow"
							>Add a Group</UButton
						>
					</div>
					<UiField
						id="sso-default-role"
						label="Role For Everyone Else"
					>
						<select
							id="sso-default-role"
							v-model="form.defaultRole"
							name="defaultRole"
							:class="inputClass"
						>
							<option
								v-for="role in SSO_CLAIM_ROLES"
								:key="role"
								:value="role"
							>
								{{ roleLabels[role] }}
							</option>
						</select>
					</UiField>
				</fieldset>

				<div
					v-if="view?.redirectUri"
					class="flex flex-col gap-1.5"
				>
					<p class="text-sm font-medium text-default">Redirect Address</p>
					<p class="text-sm text-muted">
						Enter this address in your identity provider as the sign-in redirect.
					</p>
					<div class="flex flex-wrap items-center gap-2">
						<code
							class="break-all rounded-md bg-elevated px-2 py-1 text-sm"
							data-test="redirect-uri"
							>{{ view.redirectUri }}</code
						>
						<UButton
							color="neutral"
							variant="outline"
							@click="copyAddress"
							>{{ copied ? 'Copied' : 'Copy' }}</UButton
						>
					</div>
				</div>

				<label class="flex items-center gap-2 text-sm text-default">
					<input
						v-model="form.enabled"
						type="checkbox"
						name="enabled"
					/>
					Turn on organization sign-in
				</label>
				<p
					v-if="view?.configured"
					class="text-sm text-muted"
				>
					{{
						view.lastVerifiedAt
							? `Last tested ${new Date(view.lastVerifiedAt).toLocaleString()}.`
							: 'Not tested yet. Save, then test, before you turn it on.'
					}}
				</p>

				<p
					v-if="sso.saveError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ sso.saveError.message }}
				</p>
				<p
					v-if="sso.testResult"
					:role="sso.testResult.ok ? 'status' : 'alert'"
					:class="
						sso.testResult.ok
							? 'text-sm text-default'
							: 'text-sm text-red-700 dark:text-red-400'
					"
					data-test="test-result"
				>
					{{ sso.testResult.ok ? 'The test passed.' : 'The test failed.' }}
					{{ sso.testResult.message }}
				</p>

				<div class="flex flex-wrap gap-3">
					<UButton
						type="submit"
						:loading="sso.saving"
						>Save</UButton
					>
					<UButton
						color="neutral"
						variant="outline"
						:disabled="!view?.configured"
						:loading="sso.testing"
						@click="runTest"
						>Test the Connection</UButton
					>
				</div>
			</form>
		</div>
	</ClientOnly>
</template>
