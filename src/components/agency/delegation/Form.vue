<script setup lang="ts">
import { delegationCreateSchema, type DelegationCreate } from '~/shared/agency';

const props = defineProps<{ busy: boolean; error: string | null }>();
const emit = defineEmits<{ submit: [body: DelegationCreate] }>();

const agencyOrganizationId = ref('');
const role = ref<'maintainer' | 'viewer'>('viewer');
const allSites = ref(true);
const siteIds = ref('');
const expiresOn = ref('');
const problem = ref<string | null>(null);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

function submit(): void {
	problem.value = null;
	const ids = siteIds.value
		.split(/[\s,]+/)
		.map((part) => part.trim())
		.filter(Boolean);
	const parsed = delegationCreateSchema.safeParse({
		agencyOrganizationId: agencyOrganizationId.value.trim(),
		role: role.value,
		sites: allSites.value ? 'all' : ids,
		expiresAt: expiresOn.value ? new Date(`${expiresOn.value}T23:59:59Z`).toISOString() : null
	});
	if (!parsed.success) {
		problem.value = allSites.value
			? 'Check the agency organization ID.'
			: 'Check the agency organization ID and the site IDs.';
		return;
	}
	emit('submit', parsed.data);
}
</script>

<template>
	<form
		class="flex flex-col gap-4"
		novalidate
		@submit.prevent="submit"
	>
		<label class="flex flex-col gap-1 text-sm">
			<span class="font-medium text-highlighted">Agency Organization ID</span>
			<input
				v-model="agencyOrganizationId"
				:class="inputClass"
				type="text"
				autocomplete="off"
				required
			/>
		</label>

		<fieldset class="flex flex-col gap-2 text-sm">
			<legend class="font-medium text-highlighted">Role</legend>
			<label class="flex items-center gap-2">
				<input
					v-model="role"
					type="radio"
					value="viewer"
				/>
				Viewer
			</label>
			<label class="flex items-center gap-2">
				<input
					v-model="role"
					type="radio"
					value="maintainer"
				/>
				Maintainer
			</label>
		</fieldset>

		<fieldset class="flex flex-col gap-2 text-sm">
			<legend class="font-medium text-highlighted">Sites</legend>
			<label class="flex items-center gap-2">
				<input
					v-model="allSites"
					type="checkbox"
				/>
				All Sites
			</label>
			<label
				v-if="!allSites"
				class="flex flex-col gap-1"
			>
				<span class="text-muted">Site IDs, separated by commas</span>
				<textarea
					v-model="siteIds"
					:class="inputClass"
					rows="3"
				></textarea>
			</label>
		</fieldset>

		<label class="flex flex-col gap-1 text-sm">
			<span class="font-medium text-highlighted">End Date (Optional)</span>
			<input
				v-model="expiresOn"
				:class="inputClass"
				type="date"
			/>
		</label>

		<p
			v-if="problem || error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ problem ?? error }}
		</p>

		<div class="flex justify-end">
			<UButton
				type="submit"
				:loading="busy"
				>Give Agency Access</UButton
			>
		</div>
	</form>
</template>
