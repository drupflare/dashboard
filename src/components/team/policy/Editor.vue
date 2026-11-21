<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { ACCESS_PRESETS } from '~/shared/access-presets';
import {
	RING_NAMES,
	fromDraft,
	policyGroupBodySchema,
	toDraft,
	type PolicyGroupView
} from '~/shared/policies';
import { usePoliciesStore } from '~/stores/policies';

const props = defineProps<{ orgId: string; group?: PolicyGroupView }>();
const emit = defineEmits<{ saved: [group: PolicyGroupView]; cancel: [] }>();

const store = usePoliciesStore();
const id = useId();
const name = ref(props.group?.name ?? '');
const draft = reactive(toDraft(props.group?.rules ?? {}));
const busy = ref(false);
const error = ref<string | null>(null);

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

async function submit(): Promise<void> {
	error.value = null;
	const parsed = policyGroupBodySchema.safeParse({
		name: name.value,
		rules: fromDraft(draft)
	});
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		error.value = first ? first.message : 'Check the fields and try again.';
		return;
	}
	busy.value = true;
	try {
		const saved = props.group
			? await store.update(props.orgId, props.group.id, parsed.data)
			: await store.create(props.orgId, parsed.data);
		emit('saved', saved);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<form
		class="flex flex-col gap-4"
		@submit.prevent="submit()"
	>
		<UiField
			:id="`policy-name-${id}`"
			label="Name"
			v-slot="{ describedBy }"
		>
			<input
				:id="`policy-name-${id}`"
				v-model="name"
				type="text"
				maxlength="80"
				autocomplete="off"
				aria-required="true"
				:class="inputClass"
				:aria-describedby="describedBy"
			/>
		</UiField>

		<TeamPolicyRuleRow rule="blocked-actions">
			<input
				v-model="draft.blockedActions"
				type="text"
				aria-label="Blocked Actions"
				placeholder="site.delete, site.deploy"
				:class="inputClass"
			/>
		</TeamPolicyRuleRow>
		<TeamPolicyRuleRow rule="step-up">
			<input
				v-model="draft.stepUpActions"
				type="text"
				aria-label="Actions Needing a Fresh Sign-In"
				placeholder="site.transfer, site.delete"
				:class="inputClass"
			/>
		</TeamPolicyRuleRow>
		<TeamPolicyRuleRow rule="org-sign-in">
			<label class="flex items-center gap-2 text-sm text-default">
				<input
					v-model="draft.requireOrgSignIn"
					type="checkbox"
				/>
				Require organization sign-in for administrators
			</label>
		</TeamPolicyRuleRow>
		<TeamPolicyRuleRow rule="access-presets">
			<div class="flex flex-wrap gap-x-4 gap-y-1">
				<label
					v-for="preset in ACCESS_PRESETS"
					:key="preset.id"
					class="flex items-center gap-2 text-sm text-default"
				>
					<input
						v-model="draft.allowedPresets"
						type="checkbox"
						:value="preset.id"
					/>
					{{ preset.label }}
				</label>
			</div>
			<p class="text-sm text-muted">Leave all unticked to allow every access type.</p>
		</TeamPolicyRuleRow>
		<TeamPolicyRuleRow rule="invite-domains">
			<input
				v-model="draft.inviteDomains"
				type="text"
				aria-label="Email Invite Domains"
				placeholder="example.edu"
				:class="inputClass"
			/>
		</TeamPolicyRuleRow>
		<TeamPolicyRuleRow rule="backup-retention">
			<input
				v-model="draft.minBackupRetentionDays"
				type="number"
				min="1"
				max="3650"
				aria-label="Minimum Backup Retention in Days"
				:class="inputClass"
			/>
		</TeamPolicyRuleRow>
		<TeamPolicyRuleRow rule="maintenance-window">
			<div class="flex flex-wrap gap-x-4 gap-y-1">
				<label
					v-for="(day, at) in DAYS"
					:key="day"
					class="flex items-center gap-2 text-sm text-default"
				>
					<input
						v-model="draft.windowDays"
						type="checkbox"
						:value="at"
					/>
					{{ day }}
				</label>
			</div>
			<div class="flex gap-3">
				<label class="flex flex-col gap-1 text-sm text-default">
					Start Hour (UTC)
					<input
						v-model="draft.windowStart"
						type="number"
						min="0"
						max="23"
						:class="inputClass"
					/>
				</label>
				<label class="flex flex-col gap-1 text-sm text-default">
					Hours Long
					<input
						v-model="draft.windowHours"
						type="number"
						min="1"
						max="24"
						:class="inputClass"
					/>
				</label>
			</div>
			<p class="text-sm text-muted">Leave every day unticked for no window.</p>
		</TeamPolicyRuleRow>
		<TeamPolicyRuleRow rule="ring-cohorts">
			<div class="flex flex-wrap gap-x-4 gap-y-1">
				<label
					v-for="ring in RING_NAMES"
					:key="ring"
					class="flex items-center gap-2 text-sm text-default"
				>
					<input
						v-model="draft.allowedRings"
						type="checkbox"
						:value="ring"
					/>
					{{ ring }}
				</label>
			</div>
		</TeamPolicyRuleRow>
		<TeamPolicyRuleRow rule="data-locations">
			<input
				v-model="draft.dataLocations"
				type="text"
				aria-label="Data Locations"
				placeholder="us, eu"
				:class="inputClass"
			/>
		</TeamPolicyRuleRow>
		<TeamPolicyRuleRow rule="modules">
			<input
				v-model="draft.moduleAllow"
				type="text"
				aria-label="Allowed Modules"
				placeholder="Allowed modules, by machine name"
				:class="inputClass"
			/>
			<input
				v-model="draft.moduleDeny"
				type="text"
				aria-label="Denied Modules"
				placeholder="Denied modules, by machine name"
				:class="inputClass"
			/>
		</TeamPolicyRuleRow>
		<TeamPolicyRuleRow rule="egress-allow-list">
			<input
				v-model="draft.egressAllow"
				type="text"
				aria-label="Outbound Allow-List"
				placeholder="api.example.edu"
				:class="inputClass"
			/>
		</TeamPolicyRuleRow>
		<TeamPolicyRuleRow rule="preview-ttl">
			<input
				v-model="draft.maxPreviewHours"
				type="number"
				min="1"
				max="336"
				aria-label="Preview Lifetime Cap in Hours"
				:class="inputClass"
			/>
		</TeamPolicyRuleRow>
		<TeamPolicyRuleRow rule="forbidden-templates">
			<input
				v-model="draft.forbiddenTemplates"
				type="text"
				aria-label="Forbidden Templates"
				:class="inputClass"
			/>
		</TeamPolicyRuleRow>

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
				>{{ group ? 'Save Changes' : 'Create Group' }}</UButton
			>
			<UButton
				type="button"
				color="neutral"
				variant="outline"
				@click="emit('cancel')"
				>Cancel</UButton
			>
		</div>
	</form>
</template>
