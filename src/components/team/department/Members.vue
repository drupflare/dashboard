<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import {
	DEPARTMENT_ROLE_LABEL,
	DEPARTMENT_ROLES,
	type DepartmentMemberView,
	type DepartmentRole
} from '~/shared/departments';
import { useDepartmentsStore } from '~/stores/departments';

const props = defineProps<{
	orgId: string;
	departmentId: string;
	members: DepartmentMemberView[];
	canManage: boolean;
}>();

const store = useDepartmentsStore();
const id = useId();

const email = ref('');
const role = ref<DepartmentRole>('viewer');
const busy = ref(false);
const error = ref<string | null>(null);

const roles = DEPARTMENT_ROLES.map((value) => ({ label: DEPARTMENT_ROLE_LABEL[value], value }));
const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
const nameOf = (m: DepartmentMemberView) => m.displayName ?? m.email;
const since = (at: string) => new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });

async function add(): Promise<void> {
	error.value = null;
	const address = email.value.trim();
	if (address === '') {
		error.value = 'Enter the email address of a member of this organization.';
		return;
	}
	busy.value = true;
	try {
		await store.addMember(props.orgId, props.departmentId, {
			email: address,
			role: role.value
		});
		email.value = '';
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}

async function setRole(member: DepartmentMemberView, next: DepartmentRole): Promise<void> {
	error.value = null;
	try {
		await store.changeRole(props.orgId, props.departmentId, member.userId, next);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	}
}

async function remove(member: DepartmentMemberView): Promise<void> {
	error.value = null;
	try {
		await store.removeMember(props.orgId, props.departmentId, member.userId);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	}
}
</script>

<template>
	<div class="flex flex-col gap-4">
		<UiEmptyState
			v-if="members.length === 0"
			icon="i-lucide-users"
			title="No Members Yet"
			text="People you add here can work in this department and the departments inside it."
		/>
		<div
			v-else
			class="overflow-x-auto rounded-lg border border-default"
			tabindex="0"
			role="region"
			aria-label="Department Members"
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
							Added
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
						:key="member.userId"
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
							<USelect
								v-if="canManage"
								:model-value="member.role"
								:items="roles"
								:aria-label="`Role for ${nameOf(member)}`"
								class="w-full"
								@update:model-value="setRole(member, $event as DepartmentRole)"
							/>
							<span
								v-else
								class="text-default"
								>{{ DEPARTMENT_ROLE_LABEL[member.role] }}</span
							>
						</td>
						<td class="px-3 py-2 text-default">{{ since(member.grantedAt) }}</td>
						<td class="px-3 py-2 text-right">
							<UButton
								v-if="canManage"
								color="error"
								variant="outline"
								size="sm"
								:aria-label="`Remove ${nameOf(member)}`"
								@click="remove(member)"
								>Remove</UButton
							>
						</td>
					</tr>
				</tbody>
			</table>
		</div>

		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>

		<form
			v-if="canManage"
			class="flex flex-col gap-3 sm:flex-row sm:items-end"
			@submit.prevent="add()"
		>
			<div class="flex-1">
				<UiField
					:id="`member-email-${id}`"
					label="Email"
					hint="The person has to be a member of the organization already."
					v-slot="{ describedBy }"
				>
					<input
						:id="`member-email-${id}`"
						v-model="email"
						type="email"
						autocomplete="off"
						:class="inputClass"
						:aria-describedby="describedBy"
					/>
				</UiField>
			</div>
			<UFormField label="Role">
				<USelect
					v-model="role"
					:items="roles"
					aria-label="Role"
					class="w-full sm:w-40"
				/>
			</UFormField>
			<UButton
				type="submit"
				:loading="busy"
				>Add Member</UButton
			>
		</form>
	</div>
</template>
