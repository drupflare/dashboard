<script setup lang="ts">
import { toApiClientError, useApi } from '~/composables/useApi';
import { OAUTH_LABELS, type OAuthProvider } from '~/shared/oauth';

interface Identity {
	id: string;
	provider: string;
	email: string | null;
	verified: boolean;
	createdAt: string;
}

const props = defineProps<{ justConnected?: string }>();

const session = useSessionStore();
const providers = ref<OAuthProvider[]>([]);
const identities = ref<Identity[] | null>(null);
const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const waiting = ref<(() => Promise<void>) | null>(null);

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

const labelOf = (provider: string) => OAUTH_LABELS[provider as OAuthProvider] ?? provider;

// a provider that is set up, plus any connected one an operator has since switched off
const rows = computed(() => {
	const names = new Set<string>(providers.value);
	for (const identity of identities.value ?? []) names.add(identity.provider);
	return [...names].map((provider) => ({
		provider,
		identities: (identities.value ?? []).filter((identity) => identity.provider === provider),
		canConnect: providers.value.includes(provider as OAuthProvider)
	}));
});

async function load() {
	try {
		const [list, configured] = await Promise.all([
			useApi().get<{ items: Identity[] }>('/me/identities'),
			useApi().get<{ providers: OAuthProvider[] }>('/auth/oauth')
		]);
		identities.value = list.items;
		providers.value = configured.providers;
	} catch (cause) {
		error.value = toApiClientError(cause).message;
		identities.value = identities.value ?? [];
	}
}

// a change that needs a fresh sign-in waits for the code, then runs
async function guarded(key: string, run: () => Promise<void>) {
	error.value = null;
	if (!fresh()) {
		waiting.value = () => guarded(key, run);
		return;
	}
	busy.value = key;
	try {
		await run();
	} catch (cause) {
		const apiError = toApiClientError(cause);
		const details = apiError.details as { requires?: string } | null;
		if (details?.requires === 'step-up') waiting.value = () => guarded(key, run);
		else error.value = apiError.message;
	} finally {
		busy.value = null;
	}
}

function connect(provider: string) {
	return guarded(`connect:${provider}`, async () => {
		const { url } = await useApi().post<{ url: string }>(
			`/me/identities/connect/${provider}/start`
		);
		await navigateTo(url, { external: true });
	});
}

function disconnect(identity: Identity) {
	return guarded(`remove:${identity.id}`, async () => {
		await useApi().delete(`/me/identities/${identity.id}`);
		await load();
	});
}

async function resume() {
	const next = waiting.value;
	waiting.value = null;
	if (next) await next();
}

onMounted(load);
</script>

<template>
	<section class="flex flex-col gap-4">
		<h2 class="text-lg font-semibold text-highlighted">Connected Accounts</h2>
		<p class="max-w-prose text-muted">
			Connect a provider account to sign in with it. A connection never gives Drupflare access
			to your repositories or your Cloudflare resources, and you can remove it at any time.
		</p>
		<p
			v-if="props.justConnected"
			role="status"
			class="text-sm text-green-700 dark:text-green-400"
		>
			{{ labelOf(props.justConnected) }} is connected.
		</p>
		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>
		<AccountStepUp
			v-if="waiting"
			@done="resume"
			@cancel="waiting = null"
		/>
		<p
			v-if="identities === null"
			role="status"
			class="text-sm text-muted"
		>
			Loading...
		</p>
		<p
			v-else-if="rows.length === 0"
			class="text-sm text-muted"
		>
			No provider sign-in is set up yet.
		</p>
		<ul
			v-else
			class="flex flex-col divide-y divide-default rounded-lg border border-default"
		>
			<li
				v-for="row in rows"
				:key="row.provider"
				class="flex flex-col gap-3 p-4"
			>
				<div class="flex flex-wrap items-center justify-between gap-3">
					<span class="font-medium text-highlighted">{{ labelOf(row.provider) }}</span>
					<UButton
						v-if="row.canConnect"
						size="sm"
						color="neutral"
						variant="outline"
						:loading="busy === `connect:${row.provider}`"
						@click="connect(row.provider)"
					>
						{{ row.identities.length === 0 ? 'Connect' : 'Connect Another' }}
					</UButton>
				</div>
				<p
					v-if="row.identities.length === 0"
					class="text-sm text-muted"
				>
					Not connected.
				</p>
				<ul
					v-else
					class="flex flex-col gap-2"
				>
					<li
						v-for="identity in row.identities"
						:key="identity.id"
						class="flex flex-wrap items-center justify-between gap-3 text-sm"
					>
						<span class="text-muted">
							Connected
							<template v-if="identity.email">as {{ identity.email }}</template>
							on {{ new Date(identity.createdAt).toLocaleDateString() }}
						</span>
						<UButton
							size="xs"
							color="neutral"
							variant="ghost"
							:loading="busy === `remove:${identity.id}`"
							@click="disconnect(identity)"
						>
							Remove
						</UButton>
					</li>
				</ul>
			</li>
		</ul>
	</section>
</template>
