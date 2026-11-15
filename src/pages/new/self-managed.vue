<script setup lang="ts">
import { toApiClientError, type ApiClientError } from '~/composables/useApi';
import { useOrgStore } from '~/stores/org';
import { usePlanesStore, type SelfManagedSiteBody } from '~/stores/planes';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Create in Your Cloudflare Account' });

const org = useOrgStore();
const planes = usePlanesStore();
const router = useRouter();
const token = ref('');
const notice = ref<string | null>(null);
const creating = ref(false);
const createError = ref<ApiClientError | null>(null);
const idempotencyKey = ref('');

const orgId = computed(() => org.current?.id ?? null);
const message = computed(() => planes.error?.message ?? null);
const connectMessage = computed(() => planes.connectError?.message ?? null);
const active = computed(() => (orgId.value === null ? [] : planes.activeFor(orgId.value)));

async function check(accountId?: string): Promise<void> {
	if (orgId.value === null || token.value.trim() === '') return;
	notice.value = null;
	await planes.probe(orgId.value, token.value.trim(), accountId);
}

function choose(accountId: string): void {
	void check(accountId);
}

async function connect(accountId: string): Promise<void> {
	if (orgId.value === null || token.value.trim() === '' || accountId === '') return;
	try {
		const result = await planes.connect(orgId.value, token.value.trim(), accountId);
		notice.value = result.message;
		token.value = '';
		planes.clear();
	} catch {
		// the store holds the refusal and the page shows it
	}
}

async function create(body: SelfManagedSiteBody): Promise<void> {
	if (orgId.value === null || creating.value) return;
	creating.value = true;
	createError.value = null;
	try {
		const operation = await planes.createSite(orgId.value, body, idempotencyKey.value);
		await router.push(`/new/progress/${operation.id}`);
	} catch (cause) {
		createError.value = toApiClientError(cause);
		idempotencyKey.value = crypto.randomUUID();
	} finally {
		creating.value = false;
	}
}

watch(orgId, (id) => {
	if (id !== null) void planes.loadConnections(id);
});

onMounted(() => {
	idempotencyKey.value = crypto.randomUUID();
	if (orgId.value !== null) void planes.loadConnections(orgId.value);
});

onBeforeUnmount(() => {
	planes.clear();
	token.value = '';
});
</script>

<template>
	<main class="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10">
		<header class="flex flex-col gap-2">
			<h1 class="text-2xl font-semibold text-highlighted">
				Create in Your Cloudflare Account
			</h1>
			<p class="text-sm text-muted">
				Connect a Cloudflare account once, then create, update, roll back and remove sites
				in it from the same screens as any other site. Drupflare only touches what it
				created there.
			</p>
		</header>

		<section
			v-if="active.length > 0"
			class="flex flex-col gap-6"
			aria-labelledby="self-managed-create"
		>
			<h2
				id="self-managed-create"
				class="text-lg font-semibold text-highlighted"
			>
				Create a Site
			</h2>
			<OnboardingSelfManagedCreate
				:connections="active"
				:busy="creating"
				:error="createError?.message ?? null"
				@submit="create"
			/>
		</section>

		<section
			class="flex flex-col gap-6"
			aria-labelledby="self-managed-connect"
		>
			<h2
				id="self-managed-connect"
				class="text-lg font-semibold text-highlighted"
			>
				{{
					active.length > 0
						? 'Connect Another Account'
						: 'Connect Your Cloudflare Account'
				}}
			</h2>
			<p
				v-if="notice"
				role="status"
				class="flex items-start gap-2 text-sm text-default"
			>
				<UIcon
					name="i-lucide-circle-check"
					class="mt-0.5 size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>{{ notice }}</span>
			</p>
			<OnboardingSelfManagedConnect
				v-model:token="token"
				:busy="planes.probing"
				:error="message"
				@submit="check()"
			/>
			<p
				v-if="connectMessage"
				role="alert"
				class="flex items-start gap-1.5 text-sm text-red-700 dark:text-red-400"
			>
				<UIcon
					name="i-lucide-circle-alert"
					class="mt-0.5 size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>{{ connectMessage }}</span>
			</p>
			<OnboardingSelfManagedReport
				v-if="planes.report"
				:report="planes.report"
				:connecting="planes.connecting"
				@choose="choose"
				@connect="connect"
			/>
		</section>

		<p class="text-sm text-muted">
			Manage the connected accounts on the
			<NuxtLink
				to="/planes"
				class="font-medium text-primary underline"
				>Planes</NuxtLink
			>
			page.
		</p>
	</main>
</template>
