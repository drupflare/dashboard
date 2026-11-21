<script setup lang="ts">
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import { ORG_ROLE_LABELS, type InvitePreview } from '~/shared/members';
import { useSessionStore } from '~/stores/session';

definePageMeta({ layout: 'public', middleware: ['auth'] });
useHead({ title: 'Accept an Invitation' });

const route = useRoute();
const token = String(route.params.token);
const session = useSessionStore();

const preview = ref<InvitePreview | null>(null);
const loadError = ref<ApiClientError | null>(null);
const acceptError = ref<string | null>(null);
const busy = ref(false);
const accepted = ref(false);

const expires = computed(() =>
	preview.value
		? new Date(preview.value.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
		: ''
);

async function load(): Promise<void> {
	loadError.value = null;
	try {
		preview.value = await useApi().post<InvitePreview>('/invites/preview', { token });
	} catch (cause) {
		loadError.value = toApiClientError(cause);
	}
}

async function accept(): Promise<void> {
	acceptError.value = null;
	busy.value = true;
	try {
		await useApi().post('/invites/accept', { token });
		accepted.value = true;
		await navigateTo('/org/members');
	} catch (cause) {
		acceptError.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}

onMounted(load);
</script>

<template>
	<ClientOnly>
		<div class="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-10">
			<UiErrorState
				v-if="loadError"
				title="This Invitation Cannot Be Used"
				:text="loadError.message"
				:request-id="loadError.requestId"
			/>

			<div
				v-else-if="preview === null"
				aria-busy="true"
			>
				<USkeleton class="h-32 w-full" />
			</div>

			<template v-else>
				<h1 class="text-2xl font-semibold text-highlighted">
					Join {{ preview.organizationName }}
				</h1>
				<p class="text-sm text-default">
					You are invited as {{ ORG_ROLE_LABELS[preview.role] }}. The invitation expires
					on {{ expires }}.
				</p>

				<p
					v-if="!preview.emailMatches"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					This invitation was sent to another address. Sign in with that address to accept
					it.
				</p>

				<p
					v-if="acceptError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ acceptError }}
				</p>

				<div class="flex gap-3">
					<UButton
						:loading="busy"
						:disabled="!preview.emailMatches || accepted || !session.signedIn"
						@click="accept()"
						>Accept the Invitation</UButton
					>
					<UButton
						to="/org/members"
						color="neutral"
						variant="outline"
						>Not Now</UButton
					>
				</div>
			</template>
		</div>
		<template #fallback>
			<USkeleton class="h-32 w-full" />
		</template>
	</ClientOnly>
</template>
