<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import {
	REVIEW_DECISION_LABEL,
	REVIEW_KIND_LABEL,
	type CloseResult,
	type ReviewItemView
} from '~/shared/access-reviews';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { useAccessReviewsStore } from '~/stores/access-reviews';
import { useDepartmentsStore } from '~/stores/departments';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Access Review' });

const route = useRoute();
const session = useSessionStore();
const org = useOrgStore();
const store = useAccessReviewsStore();
const departments = useDepartmentsStore();

const id = computed(() => String(route.params.id ?? ''));
const orgId = computed(() => org.current?.id ?? null);
const actions = computed<readonly string[]>(() => {
	const role = org.current?.role;
	return isOrgRole(role) ? ORG_ROLE_ACTIONS[role] : [];
});
const canManage = computed(() => actions.value.includes('review.manage'));
const settings = computed(() => (orgId.value ? store.settings.get(orgId.value)?.data : null));
// the server filters what a department admin sees; the page only decides whether to ask
const departmentAdmin = computed(
	() =>
		(orgId.value ? departments.departments.get(orgId.value)?.items : undefined)?.some(
			(d) => d.canManage
		) ?? false
);
const canRead = computed(
	() =>
		actions.value.includes('review.read') ||
		(departmentAdmin.value && settings.value?.departmentAdminsDecideReviews === true)
);

const entry = computed(() =>
	orgId.value ? store.details.get(`${orgId.value}/${id.value}`) : undefined
);
const review = computed(() => entry.value?.data ?? null);
const items = computed<ReviewItemView[]>(() => review.value?.items ?? []);
const open = computed(() => review.value?.state === 'open');
const limited = computed(() => review.value?.limited === true);
const canDecide = computed(() => canManage.value || limited.value);
const evidence = computed(() =>
	orgId.value ? store.evidence.get(`${orgId.value}/${id.value}`) : undefined
);
const csvUrl = computed(
	() =>
		`/api/v1/orgs/${encodeURIComponent(orgId.value ?? '')}/reviews/${encodeURIComponent(id.value)}/evidence?format=csv`
);
const jsonUrl = computed(
	() =>
		`/api/v1/orgs/${encodeURIComponent(orgId.value ?? '')}/reviews/${encodeURIComponent(id.value)}/evidence`
);

const view = computed(() => {
	if (session.me === undefined && session.error) return 'session-error';
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (org.current && !canRead.value) return 'no-access';
	if (entry.value === null) return 'missing';
	if (!entry.value || (entry.value.status === 'loading' && !review.value)) return 'loading';
	if (!review.value) return 'error';
	return 'review';
});

async function load() {
	if (!orgId.value) return;
	void departments.loadDepartments(orgId.value);
	void store.loadSettings(orgId.value);
	if (!canRead.value) return;
	await store.fetchDetail(orgId.value, id.value);
	if (review.value?.state === 'closed') void store.loadEvidence(orgId.value, id.value);
}

onMounted(load);
watch([orgId, id], load);
watch(canRead, (yes) => {
	if (yes) void load();
});

const day = (at: string | null) =>
	at === null ? 'Never' : new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });

const reasons = reactive<Record<string, string>>({});
const applyNow = ref(false);
const error = ref<string | null>(null);
const working = ref<string | null>(null);
const keyOf = (item: ReviewItemView) => `${item.kind}:${item.subjectRef}`;

async function decide(item: ReviewItemView, decision: 'keep' | 'revoke'): Promise<void> {
	if (!orgId.value) return;
	error.value = null;
	working.value = keyOf(item);
	try {
		const reason = reasons[keyOf(item)]?.trim();
		await store.decide(orgId.value, id.value, {
			kind: item.kind,
			subjectRef: item.subjectRef,
			decision,
			...(reason ? { reason } : {}),
			...(decision === 'revoke' && applyNow.value ? { applyNow: true } : {})
		});
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		working.value = null;
	}
}

const closeOpen = ref(false);
const closing = ref(false);
const result = ref<CloseResult | null>(null);
const removals = computed(
	() => items.value.filter((i) => i.decision === 'revoke' && !i.appliedAt).length
);

async function close(): Promise<void> {
	if (!orgId.value) return;
	error.value = null;
	closing.value = true;
	try {
		result.value = await store.close(orgId.value, id.value);
		closeOpen.value = false;
		await store.loadEvidence(orgId.value, id.value);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
		closeOpen.value = false;
	} finally {
		closing.value = false;
	}
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				:title="review ? `Review of ${review.scopeName}` : 'Access Review'"
				:text="
					review
						? `${review.total - review.pending} of ${review.total} decided. Due ${day(review.dueAt)}.`
						: ''
				"
			>
				<UButton
					v-if="open && canManage"
					@click="closeOpen = true"
					>Close Review</UButton
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
				v-else-if="view === 'no-org' || view === 'missing'"
				icon="i-lucide-clipboard-x"
				title="Review Not Found"
				text="It may belong to another organization, or it may have been removed."
			/>
			<UiEmptyState
				v-else-if="view === 'no-access'"
				icon="i-lucide-lock"
				title="Owners and Admins Only"
				:text="
					departmentAdmin
						? 'Department admins cannot decide review items in this organization right now. Ask an owner or admin.'
						: 'Ask an organization owner or admin to run access reviews.'
				"
			/>
			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading the review"
			/>
			<UiErrorState
				v-else-if="view === 'error'"
				title="Could Not Load the Review"
				:text="entry?.error?.message"
				:request-id="entry?.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="load()"
					>Try Again</UButton
				>
			</UiErrorState>

			<template v-else>
				<p
					v-if="error"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ error }}
				</p>
				<p
					v-if="result"
					role="status"
					class="text-sm text-default"
				>
					Review closed. {{ result.applied }}
					{{ result.applied === 1 ? 'removal was' : 'removals were' }} carried
					out<template v-if="result.failed > 0"
						>, and {{ result.failed }} could not be. The reason is shown on each
						item</template
					>.
				</p>
				<label
					v-if="open && canManage"
					class="flex items-start gap-2 text-sm text-default"
				>
					<input
						v-model="applyNow"
						type="checkbox"
						class="mt-0.5 size-4 shrink-0"
					/>
					Apply Now: carry out a removal as soon as you choose it, not when the review
					closes
				</label>

				<p
					v-if="limited"
					class="text-sm text-muted"
				>
					You see the items in your own departments. Owners and admins carry out the
					removals when the review closes.
				</p>
				<UiEmptyState
					v-if="items.length === 0"
					icon="i-lucide-clipboard-check"
					title="Nothing to Review"
					text="Nothing was in scope when this review opened."
				/>
				<div
					v-else
					class="overflow-x-auto rounded-lg border border-default"
					tabindex="0"
					role="region"
					aria-label="Review Items"
				>
					<table class="w-full text-left text-sm">
						<thead class="bg-elevated text-muted">
							<tr>
								<th
									scope="col"
									class="px-3 py-2 font-medium"
								>
									Item
								</th>
								<th
									scope="col"
									class="px-3 py-2 font-medium"
								>
									Decision
								</th>
								<th
									scope="col"
									class="px-3 py-2 font-medium"
								>
									<span class="sr-only">Choose</span>
								</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-default">
							<tr
								v-for="item in items"
								:key="keyOf(item)"
							>
								<th
									scope="row"
									class="px-3 py-2 font-medium wrap-break-word text-highlighted"
								>
									{{ item.label }}
									<span class="block text-xs font-normal text-muted"
										>{{ REVIEW_KIND_LABEL[item.kind] }}. {{ item.detail }}</span
									>
								</th>
								<td class="px-3 py-2 text-default">
									{{ REVIEW_DECISION_LABEL[item.decision] }}
									<span
										v-if="item.decidedBy"
										class="block text-xs text-muted"
										>by {{ item.decidedBy }}</span
									>
									<span
										v-if="item.reason"
										class="block text-xs text-muted"
										>{{ item.reason }}</span
									>
									<span
										v-if="item.appliedAt"
										class="block text-xs text-muted"
										>Removed {{ day(item.appliedAt) }}</span
									>
									<span
										v-if="item.applyError"
										class="block text-xs text-red-700 dark:text-red-400"
										>Not removed: {{ item.applyError }}</span
									>
								</td>
								<td class="px-3 py-2">
									<p
										v-if="open && item.own"
										class="text-xs text-muted"
									>
										This one is about you. Someone else decides it.
									</p>
									<div
										v-else-if="open && canDecide && !item.appliedAt"
										class="flex flex-wrap items-center justify-end gap-2"
									>
										<input
											v-model="reasons[keyOf(item)]"
											type="text"
											maxlength="500"
											placeholder="Reason (optional)"
											:aria-label="`Reason for ${item.label}`"
											class="w-44 rounded-md border border-default bg-default px-2 py-1 text-sm text-default placeholder:text-dimmed"
										/>
										<UButton
											size="sm"
											color="neutral"
											variant="outline"
											:loading="working === keyOf(item)"
											:aria-label="`Keep ${item.label}`"
											@click="decide(item, 'keep')"
											>Keep</UButton
										>
										<UButton
											size="sm"
											color="error"
											variant="outline"
											:loading="working === keyOf(item)"
											:aria-label="`Remove ${item.label}`"
											@click="decide(item, 'revoke')"
											>Remove</UButton
										>
									</div>
								</td>
							</tr>
						</tbody>
					</table>
				</div>

				<section
					v-if="review?.state === 'closed'"
					class="flex flex-col gap-3"
					aria-labelledby="evidence-heading"
				>
					<h2
						id="evidence-heading"
						class="text-lg font-semibold text-highlighted"
					>
						Evidence
					</h2>
					<p class="text-sm text-muted">
						Closed {{ day(review.closedAt) }}. Keep a copy for your records. The code
						below is the SHA-256 of the CSV file, so you can check later that a copy is
						unchanged.
					</p>
					<p
						v-if="evidence"
						class="font-mono text-xs break-all text-default"
					>
						{{ evidence.sha256 }}
					</p>
					<div class="flex flex-wrap gap-3">
						<UButton
							:to="csvUrl"
							external
							download
							color="neutral"
							variant="outline"
							icon="i-lucide-download"
							>Download CSV</UButton
						>
						<UButton
							:to="jsonUrl"
							external
							download
							color="neutral"
							variant="outline"
							icon="i-lucide-download"
							>Download JSON</UButton
						>
					</div>
				</section>
			</template>

			<UModal
				v-model:open="closeOpen"
				title="Close This Review"
				description="Every item has a decision. Closing carries out the removals and locks the record."
			>
				<template #body>
					<div class="flex flex-col gap-4">
						<p class="text-sm text-default">
							{{ removals }} {{ removals === 1 ? 'removal' : 'removals' }} will be
							carried out now. You cannot reopen a closed review.
						</p>
						<div class="flex gap-3">
							<UButton
								:loading="closing"
								@click="close()"
								>Close Review</UButton
							>
							<UButton
								color="neutral"
								variant="outline"
								@click="closeOpen = false"
								>Cancel</UButton
							>
						</div>
					</div>
				</template>
			</UModal>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full" />
		</template>
	</ClientOnly>
</template>
