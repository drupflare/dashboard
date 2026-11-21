<script setup lang="ts">
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import {
	PROCUREMENT_KIND_LABELS,
	PROCUREMENT_KINDS,
	type ProcurementBody,
	type ProcurementKind,
	type ProcurementView
} from '~/shared/procurement';
import { useOrgStore } from '~/stores/org';
import { useProcurementStore } from '~/stores/procurement';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Organization Procurement' });

const org = useOrgStore();
const procurement = useProcurementStore();

const orgId = computed(() => org.current?.id ?? null);
const role = computed(() => org.current?.role);
const canRead = computed(
	() => isOrgRole(role.value) && ORG_ROLE_ACTIONS[role.value].includes('procurement.read')
);
const canManage = computed(
	() => isOrgRole(role.value) && ORG_ROLE_ACTIONS[role.value].includes('procurement.manage')
);
const list = computed(() => (orgId.value ? procurement.records.get(orgId.value) : undefined));
const exportHref = computed(() =>
	orgId.value ? `/api/v1/orgs/${encodeURIComponent(orgId.value)}/procurement/export` : '#'
);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const editingId = ref<string | null>(null);
const form = reactive({
	kind: 'po' as ProcurementKind,
	reference: '',
	signatory: '',
	amount: '',
	issuedOn: '',
	dueOn: '',
	notes: ''
});

function fill(row: ProcurementView) {
	editingId.value = row.id;
	form.kind = row.kind;
	form.reference = row.reference;
	form.signatory = row.signatory ?? '';
	form.amount = row.amount ?? '';
	form.issuedOn = row.issuedOn ?? '';
	form.dueOn = row.dueOn ?? '';
	form.notes = row.notes ?? '';
}

function reset() {
	editingId.value = null;
	Object.assign(form, {
		kind: 'po',
		reference: '',
		signatory: '',
		amount: '',
		issuedOn: '',
		dueOn: '',
		notes: ''
	});
}

function body(): ProcurementBody {
	const optional = (value: string) => (value.trim() === '' ? undefined : value.trim());
	return {
		kind: form.kind,
		reference: form.reference.trim(),
		signatory: optional(form.signatory),
		amount: optional(form.amount),
		issuedOn: optional(form.issuedOn),
		dueOn: optional(form.dueOn),
		notes: optional(form.notes)
	};
}

async function submit() {
	if (!orgId.value) return;
	if (await procurement.save(orgId.value, editingId.value, body())) reset();
}

onMounted(() => {
	if (orgId.value && canRead.value) void procurement.load(orgId.value);
});

watch(orgId, (id) => {
	if (id && canRead.value) void procurement.load(id);
});

const state = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (org.current && !canRead.value) return 'no-access';
	if (procurement.error && list.value === undefined) return 'error';
	if (list.value === undefined) return 'loading';
	if (list.value.length === 0) return 'empty';
	return 'list';
});
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Procurement Records"
				text="Keep the quotes, purchase orders, invoices and contracts for this organization in one place. Amounts are the text you enter; Drupflare does not total or convert them."
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
				title="Only Owners, Admins and Billing Can See Procurement"
				text="Ask an owner, admin or billing member of this organization for a copy."
			/>

			<UiErrorState
				v-else-if="state === 'error'"
				title="Could Not Load the Records"
				:text="procurement.error?.message"
				:request-id="procurement.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="orgId && procurement.load(orgId, true)"
					>Try Again</UButton
				>
			</UiErrorState>

			<p
				v-else-if="state === 'loading'"
				role="status"
				class="text-sm text-muted"
			>
				Loading records
			</p>

			<template v-else>
				<div class="flex flex-wrap items-center justify-between gap-3">
					<p
						v-if="state === 'empty'"
						class="text-sm text-muted"
					>
						No procurement records yet.
					</p>
					<a
						:href="exportHref"
						class="text-sm font-medium text-brand-700 underline underline-offset-2 dark:text-brand-300"
						>Download as CSV</a
					>
				</div>

				<ul
					v-if="state === 'list'"
					class="divide-y divide-default rounded-lg border border-default"
				>
					<li
						v-for="row in list"
						:key="row.id"
						class="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
					>
						<div class="flex min-w-0 flex-col gap-1">
							<span class="font-medium text-highlighted">
								{{ PROCUREMENT_KIND_LABELS[row.kind] }} {{ row.reference }}
							</span>
							<span class="text-sm text-muted">
								{{
									[row.amount, row.issuedOn, row.dueOn].filter(Boolean).join(', ')
								}}
							</span>
						</div>
						<UButton
							v-if="canManage"
							color="neutral"
							@click="fill(row)"
							>Edit {{ row.reference }}</UButton
						>
					</li>
				</ul>

				<form
					v-if="canManage"
					class="flex flex-col gap-4 rounded-lg border border-default p-4 sm:max-w-2xl"
					@submit.prevent="submit"
				>
					<h2 class="text-lg font-semibold text-highlighted">
						{{ editingId ? 'Edit a Record' : 'Add a Record' }}
					</h2>
					<label class="flex flex-col gap-1">
						<span class="text-sm font-medium text-highlighted">Kind</span>
						<select
							v-model="form.kind"
							:class="inputClass"
						>
							<option
								v-for="kind in PROCUREMENT_KINDS"
								:key="kind"
								:value="kind"
							>
								{{ PROCUREMENT_KIND_LABELS[kind] }}
							</option>
						</select>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-sm font-medium text-highlighted">Reference</span>
						<input
							v-model="form.reference"
							:class="inputClass"
							maxlength="120"
							required
						/>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-sm font-medium text-highlighted">Signatory</span>
						<input
							v-model="form.signatory"
							:class="inputClass"
							maxlength="160"
						/>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-sm font-medium text-highlighted">Amount</span>
						<input
							v-model="form.amount"
							:class="inputClass"
							maxlength="64"
							placeholder="As written on the document"
						/>
					</label>
					<div class="grid gap-4 sm:grid-cols-2">
						<label class="flex flex-col gap-1">
							<span class="text-sm font-medium text-highlighted">Issued On</span>
							<input
								v-model="form.issuedOn"
								type="date"
								:class="inputClass"
							/>
						</label>
						<label class="flex flex-col gap-1">
							<span class="text-sm font-medium text-highlighted">Due On</span>
							<input
								v-model="form.dueOn"
								type="date"
								:class="inputClass"
							/>
						</label>
					</div>
					<label class="flex flex-col gap-1">
						<span class="text-sm font-medium text-highlighted">Notes</span>
						<textarea
							v-model="form.notes"
							:class="inputClass"
							rows="3"
							maxlength="2000"
						/>
					</label>

					<p
						v-if="procurement.saveError"
						role="alert"
						class="text-sm text-error"
					>
						{{ procurement.saveError.message }}
					</p>

					<div class="flex gap-2">
						<UButton
							type="submit"
							:loading="procurement.saving"
							>{{ editingId ? 'Save Record' : 'Add Record' }}</UButton
						>
						<UButton
							v-if="editingId"
							color="neutral"
							@click="reset"
							>Cancel</UButton
						>
					</div>
				</form>
			</template>
		</div>
	</ClientOnly>
</template>
