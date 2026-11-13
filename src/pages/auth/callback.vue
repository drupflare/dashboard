<script setup lang="ts">
import { toApiClientError, useApi } from '~/composables/useApi';
import {
	OAUTH_LABELS,
	OAUTH_PROVIDERS,
	orgOfRepoState,
	providerOfState,
	purposeOfState,
	type OAuthProvider
} from '~/shared/oauth';

definePageMeta({ layout: 'auth' });
useHead({ title: 'Signing In' });

type Result =
	{ status: 'signed_in' } | { status: 'link_required'; provider: string; email: string };

const route = useRoute();
const session = useSessionStore();

const phase = ref<'working' | 'signin' | 'confirm' | 'repo' | 'failed'>('working');
const message = ref('');
const linkEmail = ref('');
const linkProvider = ref<OAuthProvider | null>(null);
const connecting = ref(false);
const linking = ref(false);
const needsStepUp = ref(false);

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

const linkLabel = computed(() => (linkProvider.value ? OAUTH_LABELS[linkProvider.value] : ''));
const linkLabelOf = (provider: OAuthProvider | undefined) =>
	provider ? OAUTH_LABELS[provider] : 'The provider';

function fail(text: string) {
	message.value = text;
	phase.value = 'failed';
}

function single(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function providerNamed(value: string | undefined): OAuthProvider | null {
	return (OAUTH_PROVIDERS as readonly string[]).includes(value ?? '')
		? (value as OAuthProvider)
		: null;
}

// the link cookie lasts 15 minutes, so a sign-in can resume here
async function showLinkStep() {
	await session.load();
	phase.value = session.me ? 'confirm' : 'signin';
}

// the OAuth code is single-use, so only the provider comes back
const signInRedirect = () =>
	`/login?redirect=${encodeURIComponent(`/auth/callback?link=${linkProvider.value}`)}`;

type RepoReturn = {
	orgId: string;
	provider: OAuthProvider;
	body: Record<string, string>;
};

const repoReturn = ref<RepoReturn | null>(null);

function stepUpDone() {
	needsStepUp.value = false;
	if (repoReturn.value) void finishRepo();
	else void confirmLink();
}

// a repository connection needs a fresh sign-in, so a stale session asks for one and then resumes
async function finishRepo() {
	const pending = repoReturn.value;
	if (!pending) return;
	await session.load();
	if (!session.me) {
		fail('Your session has ended. Sign in, then start the connection again.');
		return;
	}
	if (!fresh()) {
		needsStepUp.value = true;
		phase.value = 'repo';
		return;
	}
	phase.value = 'working';
	try {
		await useApi().post(`/orgs/${pending.orgId}/repo-connections/complete`, pending.body);
		await navigateTo(`/org/integrations?connected=${pending.provider}`);
	} catch (cause) {
		const apiError = toApiClientError(cause);
		const details = apiError.details as { requires?: string } | null;
		if (details?.requires === 'step-up') {
			needsStepUp.value = true;
			phase.value = 'repo';
			return;
		}
		fail(apiError.message);
	}
}

async function confirmLink() {
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	linking.value = true;
	try {
		await useApi().post('/me/identities/link');
		await navigateTo(`/account?connected=${linkProvider.value}`);
	} catch (cause) {
		const apiError = toApiClientError(cause);
		const details = apiError.details as { requires?: string } | null;
		if (details?.requires === 'step-up') {
			needsStepUp.value = true;
			return;
		}
		connecting.value = true;
		fail(apiError.message);
	} finally {
		linking.value = false;
	}
}

onMounted(async () => {
	const state = single(route.query.state);
	const code = single(route.query.code);
	const error = single(route.query.error);
	const provider = state ? providerOfState(state) : null;
	const linked = providerNamed(single(route.query.link));
	if (!state && !code && !error && linked) {
		linkProvider.value = linked;
		await showLinkStep();
		return;
	}
	const repoOrg = state ? orgOfRepoState(state) : null;
	if (state && provider && repoOrg) {
		connecting.value = true;
		const installationId = single(route.query.installation_id);
		if (error || (!code && !installationId)) {
			fail(
				single(route.query.setup_action) === 'request'
					? 'The owner of that GitHub organization has to approve the installation first. Connect again once they have.'
					: 'The provider did not finish the connection. Start again from the integrations page.'
			);
			return;
		}
		const body: Record<string, string> = { provider, state };
		if (code) body.code = code;
		if (installationId) body.installationId = installationId;
		repoReturn.value = { orgId: repoOrg, provider, body };
		await finishRepo();
		return;
	}
	if (!state || !provider || (!code && !error)) {
		fail('The sign-in link is not complete. Start again from the sign-in page.');
		return;
	}
	const query: Record<string, string> = { state };
	if (code) query.code = code;
	if (error) query.error = error;
	if (purposeOfState(state) === 'link') {
		connecting.value = true;
		try {
			await useApi().get(`/me/identities/connect/${provider}/callback`, query);
			await navigateTo(`/account?connected=${provider}`);
		} catch (cause) {
			fail(toApiClientError(cause).message);
		}
		return;
	}
	try {
		const result = await useApi().get<Result>(`/auth/oauth/${provider}/callback`, query);
		if (result.status === 'link_required') {
			linkEmail.value = result.email;
			linkProvider.value = providerNamed(result.provider);
			await showLinkStep();
			return;
		}
		await session.load();
		await navigateTo('/sites');
	} catch (cause) {
		fail(toApiClientError(cause).message);
	}
});
</script>

<template>
	<div class="flex flex-col gap-4">
		<template v-if="phase === 'working'">
			<h1 class="text-xl font-bold text-highlighted">
				{{ connecting ? 'Connecting Your Account' : 'Signing You In' }}
			</h1>
			<p
				role="status"
				class="text-muted"
			>
				{{
					connecting
						? 'Finishing the connection with your provider.'
						: 'Finishing the sign-in with your provider.'
				}}
			</p>
		</template>
		<template v-else-if="phase === 'signin'">
			<h1 class="text-xl font-bold text-highlighted">Sign In to Confirm</h1>
			<p
				v-if="linkEmail"
				class="text-muted"
			>
				An account for <span class="break-all font-medium">{{ linkEmail }}</span> already
				exists.
			</p>
			<p class="text-muted">
				Sign in to that account first, then confirm the link to {{ linkLabel }}. Nothing
				merges until you confirm.
			</p>
			<UButton
				:to="signInRedirect()"
				block
				>Sign In</UButton
			>
		</template>
		<template v-else-if="phase === 'confirm'">
			<h1 class="text-xl font-bold text-highlighted">Confirm the Link</h1>
			<p class="text-muted">
				Connect {{ linkLabel }} to
				<span class="break-all font-medium">{{ session.me?.email }}</span
				>. Nothing merges until you confirm, and you can remove the connection from Account
				at any time.
			</p>
			<AccountStepUp
				v-if="needsStepUp"
				@done="stepUpDone"
				@cancel="needsStepUp = false"
			/>
			<div class="flex gap-3">
				<UButton
					:loading="linking"
					@click="confirmLink"
					>Confirm Link</UButton
				>
				<UButton
					to="/account"
					color="neutral"
					variant="outline"
					>Cancel</UButton
				>
			</div>
		</template>
		<template v-else-if="phase === 'repo'">
			<h1 class="text-xl font-bold text-highlighted">Confirm Your Sign-In</h1>
			<p class="text-muted">
				{{ linkLabelOf(repoReturn?.provider) }} sent you back. Confirm your sign-in to
				finish connecting your repositories.
			</p>
			<AccountStepUp
				v-if="needsStepUp"
				@done="stepUpDone"
				@cancel="
					fail('The connection was not finished. Start again from the integrations page.')
				"
			/>
		</template>
		<template v-else>
			<h1 class="text-xl font-bold text-highlighted">
				{{ connecting ? 'Connection Did Not Finish' : 'Sign-In Did Not Finish' }}
			</h1>
			<p
				role="alert"
				class="text-muted"
			>
				{{ message }}
			</p>
			<UButton
				:to="connecting ? '/account' : '/login'"
				block
				>{{ connecting ? 'Back to Account' : 'Back to Sign In' }}</UButton
			>
		</template>
	</div>
</template>
