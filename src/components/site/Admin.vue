<script setup lang="ts">
import type { AdminPasswordState } from '@contracts/sites';
import { type ApiClientError, toApiClientError, useApi } from '~/composables/useApi';

const props = defineProps<{
	orgId: string;
	siteId: string;
	signInUrl: string;
	username: string | null;
	email: string | null;
}>();

// undefined: not loaded; null: the site has no password record to read; a string: loaded
const password = ref<AdminPasswordState | null | undefined>(undefined);
const failure = ref<ApiClientError | null>(null);

async function load(): Promise<void> {
	failure.value = null;
	try {
		const reply = await useApi().get<{ kind: string; state: AdminPasswordState }>(
			`/orgs/${encodeURIComponent(props.orgId)}/sites/${encodeURIComponent(props.siteId)}/first-run-secret`
		);
		password.value = reply.state;
	} catch (error) {
		const apiError = toApiClientError(error);
		if (apiError.status === 404) {
			password.value = null;
			return;
		}
		failure.value = apiError;
	}
}

onMounted(() => void load());

const needsRecovery = computed(
	() => password.value !== undefined && password.value !== 'available'
);
</script>

<template>
	<section
		class="flex flex-col gap-4"
		aria-labelledby="site-admin-heading"
	>
		<h2
			id="site-admin-heading"
			class="text-lg font-semibold text-highlighted"
		>
			Admin Sign-In
		</h2>

		<dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
			<dt class="text-muted">Username</dt>
			<dd class="wrap-break-word text-highlighted">{{ username ?? 'Not Recorded' }}</dd>
			<dt class="text-muted">Email</dt>
			<dd class="wrap-break-word text-highlighted">{{ email ?? 'Not Recorded' }}</dd>
		</dl>

		<div>
			<UButton
				color="neutral"
				variant="outline"
				icon="i-lucide-external-link"
				:href="signInUrl"
				target="_blank"
				rel="noopener"
			>
				Open Sign-In Page
			</UButton>
		</div>

		<div class="flex flex-col gap-2">
			<h3 class="text-base font-semibold text-highlighted">Password</h3>

			<UiErrorState
				v-if="failure"
				title="Could Not Load the Password State"
				:text="failure.message"
				:request-id="failure.requestId"
			>
				<UButton
					color="neutral"
					@click="load()"
				>
					Try Again
				</UButton>
			</UiErrorState>

			<div
				v-else-if="password === undefined"
				role="status"
				aria-label="Loading the password state"
				class="flex flex-col gap-2"
			>
				<USkeleton class="h-4 w-64 max-w-full" />
				<USkeleton class="h-8 w-36" />
			</div>

			<UiSecretOnce
				v-else-if="password === 'available'"
				:org-id="orgId"
				:site-id="siteId"
			/>

			<p
				v-else-if="password === 'revealed'"
				class="text-sm text-muted"
			>
				The password was shown once and is not stored.
			</p>

			<p
				v-else-if="password === 'expired'"
				class="text-sm text-muted"
			>
				The password can no longer be shown.
			</p>

			<p
				v-else
				class="text-sm text-muted"
			>
				This site was created before the dashboard recorded its password.
			</p>

			<p
				v-if="needsRecovery && !failure"
				class="text-sm text-muted"
			>
				To set a new one, use "Forgot password" on the site's sign-in page. It emails
				{{ email ?? 'the admin address' }}. We have not tested that the email arrives.
			</p>
		</div>
	</section>
</template>
