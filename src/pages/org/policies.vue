<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { POLICY_RULE_INFO, ruleIdsIn, type PolicyGroupView } from '~/shared/policies';
import { useDepartmentsStore } from '~/stores/departments';
import { useOrgStore } from '~/stores/org';
import { usePoliciesStore } from '~/stores/policies';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Policies' });

const session = useSessionStore();
const org = useOrgStore();
const store = usePoliciesStore();
const departments = useDepartmentsStore();

const orgId = computed(() => org.current?.id ?? null);
const list = computed(() => (orgId.value ? store.policies.get(orgId.value) : undefined));
const rows = computed(() => list.value?.items ?? []);
const departmentRows = computed(() =>
	orgId.value ? (departments.departments.get(orgId.value)?.items ?? []) : []
);
const siteRows = computed(() =>
	orgId.value ? (departments.placements.get(orgId.value)?.items ?? []) : []
);

const editing = ref<string | null>(null);
const removeError = ref<string | null>(null);

const view = computed(() => {
	if (session.me === undefined && session.error) return 'session-error';
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (list.value === null) return 'no-org';
	if (!list.value || (list.value.status === 'loading' && rows.value.length === 0))
		return 'loading';
	if (list.value.status === 'error') return 'error';
	return 'list';
});

function load(id: string) {
	void store.load(id);
	void departments.loadDepartments(id);
	void departments.loadPlacements(id);
}

onMounted(() => {
	if (orgId.value) load(orgId.value);
});

watch(orgId, (id) => {
	if (id) load(id);
});

function reload() {
	if (orgId.value) void store.fetch(orgId.value);
}

const summary = (group: PolicyGroupView) => ruleIdsIn(group.rules);

async function remove(group: PolicyGroupView) {
	if (!orgId.value) return;
	removeError.value = null;
	try {
		await store.remove(orgId.value, group.id);
	} catch (cause) {
		removeError.value = toApiClientError(cause).message;
	}
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Policies"
				text="Guardrails that cap what any role can do, assigned to the organization, a department, a site or a data classification."
			>
				<UButton
					v-if="view === 'list' && editing === null"
					icon="i-lucide-plus"
					@click="editing = 'new'"
					>New Policy Group</UButton
				>
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

			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading policies"
			/>

			<UiErrorState
				v-else-if="view === 'error'"
				title="Could Not Load Policies"
				:text="list?.error?.message"
				:request-id="list?.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="reload"
					>Try Again</UButton
				>
			</UiErrorState>

			<template v-else-if="orgId">
				<section
					v-if="editing === 'new'"
					aria-labelledby="new-policy"
					class="flex flex-col gap-3"
				>
					<h2
						id="new-policy"
						class="text-lg font-medium text-highlighted"
					>
						New Policy Group
					</h2>
					<TeamPolicyEditor
						:org-id="orgId"
						@saved="editing = null"
						@cancel="editing = null"
					/>
				</section>

				<UiEmptyState
					v-if="rows.length === 0 && editing !== 'new'"
					icon="i-lucide-shield-check"
					title="No Policy Groups Yet"
					text="Create a group to set guardrails, then assign it to the organization, a department, a site or a classification."
				/>

				<p
					v-if="removeError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ removeError }}
				</p>

				<section
					v-for="group in rows"
					:key="group.id"
					:aria-labelledby="`policy-${group.id}`"
					class="flex flex-col gap-3 rounded-md border border-default p-4"
				>
					<div class="flex flex-wrap items-baseline justify-between gap-3">
						<h2
							:id="`policy-${group.id}`"
							class="text-lg font-medium wrap-break-word text-highlighted"
						>
							{{ group.name }}
						</h2>
						<div
							v-if="editing !== group.id"
							class="flex gap-2"
						>
							<UButton
								size="sm"
								color="neutral"
								variant="outline"
								@click="editing = group.id"
								>Edit</UButton
							>
							<UButton
								size="sm"
								color="neutral"
								variant="outline"
								:aria-label="`Delete ${group.name}`"
								@click="remove(group)"
								>Delete</UButton
							>
						</div>
					</div>

					<TeamPolicyEditor
						v-if="editing === group.id"
						:org-id="orgId"
						:group="group"
						@saved="editing = null"
						@cancel="editing = null"
					/>
					<template v-else>
						<ul
							v-if="summary(group).length > 0"
							class="flex flex-col gap-1 text-sm text-default"
						>
							<li
								v-for="rule in summary(group)"
								:key="rule"
							>
								<span class="font-medium">{{ POLICY_RULE_INFO[rule].label }}</span>
								<span
									v-if="POLICY_RULE_INFO[rule].notEnforced"
									class="text-muted"
								>
									- Saved, not enforced yet</span
								>
							</li>
						</ul>
						<p
							v-else
							class="text-sm text-muted"
						>
							This group has no rules yet.
						</p>
					</template>

					<TeamPolicyAssignments
						:org-id="orgId"
						:group="group"
						:departments="departmentRows"
						:sites="siteRows"
					/>
				</section>

				<section
					aria-labelledby="classification-heading"
					class="flex flex-col gap-3"
				>
					<h2
						id="classification-heading"
						class="text-lg font-medium text-highlighted"
					>
						Data Classification
					</h2>
					<p class="text-sm text-muted">
						Each site can carry one of four labels. Name them the way your organization
						does and pick the policy group a label applies by default.
					</p>
					<TeamPolicyClassifications
						:org-id="orgId"
						:entries="list?.classifications ?? []"
						:groups="rows"
					/>
				</section>
			</template>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full" />
		</template>
	</ClientOnly>
</template>
