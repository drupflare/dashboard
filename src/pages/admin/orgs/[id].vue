<script setup lang="ts">
import { adminGet } from '~/composables/useAdminApi';
import { toApiClientError } from '~/composables/useApi';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth'] });

interface OrgDetail {
	id: string;
	name: string;
	personal: boolean;
	createdBy: string;
	createdAt: number;
	members: number;
	sites: Record<string, number>;
	plan: string | null;
	subscription: { status: string; entitlementState: string } | null;
}

const route = useRoute();
const session = useSessionStore();
const org = ref<OrgDetail | null>(null);
const status = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');

async function load(): Promise<void> {
	status.value = 'loading';
	try {
		org.value = await adminGet<OrgDetail>(`/admin/organizations/${String(route.params.id)}`);
		status.value = 'ready';
	} catch (cause) {
		error.value = toApiClientError(cause).message;
		status.value = 'error';
	}
}

onMounted(() => void load());

const siteRows = computed(() => Object.entries(org.value?.sites ?? {}));

useHead({ title: 'Organization' });
</script>

<template>
	<UiEmptyState
		v-if="session.me !== undefined && session.me?.platformRole !== 'admin'"
		icon="i-lucide-file-question"
		title="Page Not Found"
		text="There is nothing at this address."
	/>
	<div
		v-else
		class="flex flex-col gap-6"
	>
		<UiErrorState
			v-if="status === 'error'"
			title="Organization Could Not Load"
			:text="error"
		>
			<UButton
				color="neutral"
				variant="outline"
				@click="load()"
				>Try Again</UButton
			>
		</UiErrorState>
		<p
			v-else-if="status === 'loading' || org === null"
			role="status"
			class="text-sm text-muted"
		>
			Loading the organization
		</p>
		<template v-else>
			<UiPageHeader
				:title="org.name"
				:text="org.personal ? 'A personal organization.' : 'An organization.'"
			/>
			<dl class="grid max-w-xl grid-cols-2 gap-y-3 text-sm">
				<dt class="text-muted">ID</dt>
				<dd class="font-mono text-xs">{{ org.id }}</dd>
				<dt class="text-muted">Members</dt>
				<dd>{{ org.members }}</dd>
				<dt class="text-muted">Plan</dt>
				<dd>{{ org.plan ?? 'No billing record yet. The free plan applies.' }}</dd>
				<dt class="text-muted">Subscription</dt>
				<dd>
					{{
						org.subscription
							? `${org.subscription.status}, ${org.subscription.entitlementState}`
							: 'None'
					}}
				</dd>
				<dt class="text-muted">Notification Activity</dt>
				<dd>Not recorded yet.</dd>
			</dl>
			<section class="flex max-w-xl flex-col gap-2">
				<h2 class="text-lg font-semibold text-highlighted">Sites by State</h2>
				<p
					v-if="siteRows.length === 0"
					class="text-muted"
				>
					No sites yet.
				</p>
				<dl
					v-else
					class="grid grid-cols-2 gap-y-2 text-sm"
				>
					<template
						v-for="[state, count] in siteRows"
						:key="state"
					>
						<dt class="text-muted">{{ state }}</dt>
						<dd>{{ count }}</dd>
					</template>
				</dl>
			</section>
		</template>
	</div>
</template>
