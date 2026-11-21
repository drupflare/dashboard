<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import {
	REVIEW_INTERVAL_LABEL,
	REVIEW_INTERVALS,
	REVIEW_KIND_LABEL,
	STALE_DAYS,
	type ReviewInterval,
	type ReviewView
} from '~/shared/access-reviews';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { useAccessReviewsStore } from '~/stores/access-reviews';
import { useDepartmentsStore } from '~/stores/departments';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Access Reviews' });

const session = useSessionStore();
const org = useOrgStore();
const store = useAccessReviewsStore();
const departments = useDepartmentsStore();

const orgId = computed(() => org.current?.id ?? null);
const actions = computed<readonly string[]>(() => {
	const role = org.current?.role;
	return isOrgRole(role) ? ORG_ROLE_ACTIONS[role] : [];
});
const canManage = computed(() => actions.value.includes('review.manage'));
const canChangeSettings = computed(() => actions.value.includes('org.update'));
const settings = computed(() => (orgId.value ? store.settings.get(orgId.value)?.data : null));
// unknown until the answer arrives, so a department admin never sees a list that then vanishes
const departmentAdminsDecide = computed(
	() => settings.value?.departmentAdminsDecideReviews === true
);
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
		(departmentAdmin.value && departmentAdminsDecide.value)
);

const list = computed(() => (orgId.value ? store.lists.get(orgId.value) : undefined));
const rows = computed<ReviewView[]>(() => list.value?.data ?? []);
const schedule = computed(() => (orgId.value ? store.schedules.get(orgId.value)?.data : null));
const stale = computed(() => (orgId.value ? store.stale.get(orgId.value) : undefined));
const departmentChoices = computed(
	() =>
		(orgId.value ? departments.departments.get(orgId.value)?.items : undefined)?.map((d) => ({
			label: d.name,
			value: d.id
		})) ?? []
);

const view = computed(() => {
	if (session.me === undefined && session.error) return 'session-error';
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (org.current && !canRead.value) return 'no-access';
	if (list.value === null) return 'no-org';
	if (!list.value || (list.value.status === 'loading' && rows.value.length === 0))
		return 'loading';
	if (rows.value.length === 0 && list.value.status === 'error') return 'error';
	if (rows.value.length === 0) return 'empty';
	return 'list';
});

function loadAll(id: string) {
	void departments.loadDepartments(id);
	void store.loadSettings(id);
	if (!canRead.value) return;
	void store.loadList(id);
	if (actions.value.includes('review.read')) void store.loadSchedule(id);
}

watch(canRead, (yes) => {
	if (yes && orgId.value) loadAll(orgId.value);
});

onMounted(() => {
	if (orgId.value) loadAll(orgId.value);
});

watch(orgId, (id) => {
	if (id) loadAll(id);
});

const day = (at: string | null) =>
	at === null ? 'Never' : new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });

const intervals = REVIEW_INTERVALS.map((value) => ({
	label: REVIEW_INTERVAL_LABEL[value],
	value
}));
const scheduleError = ref<string | null>(null);

async function changeInterval(value: ReviewInterval): Promise<void> {
	if (!orgId.value) return;
	scheduleError.value = null;
	try {
		await store.setSchedule(orgId.value, value);
	} catch (cause) {
		scheduleError.value = toApiClientError(cause).message;
	}
}

const settingsError = ref<string | null>(null);

async function changeSetting(value: boolean): Promise<void> {
	if (!orgId.value) return;
	settingsError.value = null;
	try {
		await store.setSettings(orgId.value, { departmentAdminsDecideReviews: value });
	} catch (cause) {
		settingsError.value = toApiClientError(cause).message;
	}
}

async function created(review: ReviewView) {
	await navigateTo(`/org/reviews/${encodeURIComponent(review.id)}`);
}

function checkStale() {
	if (orgId.value) void store.loadStale(orgId.value);
}

const progress = (review: ReviewView) => `${review.total - review.pending} of ${review.total}`;
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-8">
			<UiPageHeader
				title="Access Reviews"
				text="Check who and what still needs access. Owners and admins keep or remove each item, department admins decide their own department, and a closed review is evidence."
			>
				<TeamReviewOpenDialog
					v-if="orgId && canManage"
					:org-id="orgId"
					:departments="departmentChoices"
					@created="created"
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
				:text="
					departmentAdmin
						? 'Department admins cannot decide review items in this organization right now. Ask an owner or admin.'
						: 'Ask an organization owner or admin to run access reviews.'
				"
			/>
			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading reviews"
			/>
			<UiErrorState
				v-else-if="view === 'error'"
				title="Could Not Load Reviews"
				:text="list?.error?.message"
				:request-id="list?.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="orgId && store.fetchList(orgId)"
					>Try Again</UButton
				>
			</UiErrorState>

			<template v-if="view === 'empty' || view === 'list'">
				<UiEmptyState
					v-if="view === 'empty'"
					icon="i-lucide-clipboard-check"
					title="No Reviews Yet"
					text="Open a review to check every member, grant, key and service account in one pass."
				/>
				<div
					v-else
					class="overflow-x-auto rounded-lg border border-default"
					tabindex="0"
					role="region"
					aria-label="Reviews"
				>
					<table class="w-full text-left text-sm">
						<thead class="bg-elevated text-muted">
							<tr>
								<th
									scope="col"
									class="px-3 py-2 font-medium"
								>
									Covers
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
									Decided
								</th>
								<th
									scope="col"
									class="px-3 py-2 font-medium"
								>
									Due
								</th>
								<th
									scope="col"
									class="px-3 py-2 font-medium"
								>
									<span class="sr-only">Open</span>
								</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-default">
							<tr
								v-for="review in rows"
								:key="review.id"
							>
								<th
									scope="row"
									class="px-3 py-2 font-medium text-highlighted"
								>
									{{ review.scopeName }}
								</th>
								<td class="px-3 py-2 text-default">
									{{ review.state === 'open' ? 'Open' : 'Closed' }}
								</td>
								<td class="px-3 py-2 text-default">{{ progress(review) }}</td>
								<td class="px-3 py-2 text-default">{{ day(review.dueAt) }}</td>
								<td class="px-3 py-2 text-right">
									<UButton
										size="sm"
										color="neutral"
										variant="outline"
										:to="`/org/reviews/${encodeURIComponent(review.id)}`"
										:aria-label="`Open the review of ${review.scopeName}`"
										>Open</UButton
									>
								</td>
							</tr>
						</tbody>
					</table>
				</div>

				<section
					v-if="canChangeSettings"
					class="flex flex-col gap-3"
					aria-labelledby="settings-heading"
				>
					<h2
						id="settings-heading"
						class="text-lg font-semibold text-highlighted"
					>
						Who Can Decide
					</h2>
					<label class="flex items-start gap-2 text-sm text-default">
						<input
							type="checkbox"
							class="mt-0.5 size-4 shrink-0"
							:checked="settings?.departmentAdminsDecideReviews ?? true"
							@change="changeSetting(($event.target as HTMLInputElement).checked)"
						/>
						Department admins can decide review items
					</label>
					<p class="text-sm text-muted">
						A department admin decides only the items in their own department. Turning
						this off keeps every decision already made and stops department admins from
						making new ones.
					</p>
					<p
						v-if="settingsError"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ settingsError }}
					</p>
				</section>

				<section
					v-if="canManage"
					class="flex flex-col gap-3"
					aria-labelledby="schedule-heading"
				>
					<h2
						id="schedule-heading"
						class="text-lg font-semibold text-highlighted"
					>
						Repeat Automatically
					</h2>
					<p class="text-sm text-muted">
						A review of the whole organization opens by itself on this schedule. It
						waits while another one is still open.
					</p>
					<div class="flex flex-wrap items-center gap-3">
						<USelect
							:model-value="schedule?.interval ?? 'off'"
							:items="intervals"
							:disabled="!canManage"
							aria-label="Repeat Automatically"
							class="w-48"
							@update:model-value="changeInterval($event as ReviewInterval)"
						/>
						<span
							v-if="schedule?.lastOpenedAt"
							class="text-sm text-muted"
							>Last opened {{ day(schedule.lastOpenedAt) }}.</span
						>
					</div>
					<p
						v-if="scheduleError"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ scheduleError }}
					</p>
				</section>

				<section
					v-if="canManage"
					class="flex flex-col gap-3"
					aria-labelledby="stale-heading"
				>
					<h2
						id="stale-heading"
						class="text-lg font-semibold text-highlighted"
					>
						Unused Credentials
					</h2>
					<p class="text-sm text-muted">
						Keys, service accounts and site access that nobody has used for
						{{ STALE_DAYS }} days. Site access keeps no use record, so it is listed by
						age.
					</p>
					<UButton
						class="self-start"
						color="neutral"
						variant="outline"
						:loading="stale?.status === 'loading'"
						@click="checkStale()"
						>Check Now</UButton
					>
					<p
						v-if="stale?.status === 'error'"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ stale.error?.message }}
					</p>
					<p
						v-else-if="stale?.status === 'ready' && stale.data?.items.length === 0"
						class="text-sm text-default"
					>
						Nothing has gone unused for {{ STALE_DAYS }} days.
					</p>
					<div
						v-else-if="stale?.status === 'ready' && stale.data"
						tabindex="0"
						role="region"
						aria-label="Unused Access"
						class="overflow-x-auto rounded-lg border border-default"
					>
						<table class="w-full text-left text-sm">
							<thead class="bg-elevated text-muted">
								<tr>
									<th
										scope="col"
										class="px-3 py-2 font-medium"
									>
										What
									</th>
									<th
										scope="col"
										class="px-3 py-2 font-medium"
									>
										Type
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
										Days
									</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-default">
								<tr
									v-for="item in stale.data.items"
									:key="`${item.kind}:${item.subjectRef}`"
								>
									<th
										scope="row"
										class="px-3 py-2 font-medium wrap-break-word text-highlighted"
									>
										{{ item.label }}
									</th>
									<td class="px-3 py-2 text-default">
										{{
											item.kind === 'grant'
												? REVIEW_KIND_LABEL.grant
												: item.kind === 'api-key'
													? REVIEW_KIND_LABEL['api-key']
													: REVIEW_KIND_LABEL['service-account']
										}}
									</td>
									<td class="px-3 py-2 text-default">
										{{
											item.lastUsedAt ? day(item.lastUsedAt) : 'Not recorded'
										}}
									</td>
									<td class="px-3 py-2 text-default">{{ item.days }}</td>
								</tr>
							</tbody>
						</table>
					</div>
				</section>
			</template>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full" />
		</template>
	</ClientOnly>
</template>
