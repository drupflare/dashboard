<script setup lang="ts">
import type { ImportCredential } from '~/stores/imports';

interface ServerValues {
	host: string;
	port: number;
	username: string;
	root: string;
}

const props = defineProps<{
	credential: ImportCredential | null;
	busy: boolean;
	error?: string | null;
}>();
const emit = defineEmits<{ submit: [values: ServerValues]; next: [] }>();

const host = defineModel<string>('host', { required: true });
const port = defineModel<string>('port', { required: true });
const username = defineModel<string>('username', { required: true });
const root = defineModel<string>('root', { required: true });

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/i;
const ROOT_RE = /^\/[A-Za-z0-9._/-]+$/;

const submitted = ref(false);
const copyState = ref<'idle' | 'copied' | 'failed'>('idle');

function portNumber(): number | null {
	const text = port.value.trim();
	const value = Number(text);
	return /^\d+$/.test(text) && value >= 1 && value <= 65535 ? value : null;
}

const problems = computed(() => ({
	host:
		host.value.trim() === '' || /\s/.test(host.value.trim())
			? 'Enter the address of your server, with no spaces.'
			: null,
	port: portNumber() === null ? 'Use a port from 1 to 65535.' : null,
	username: USERNAME_RE.test(username.value)
		? null
		: 'Start with a letter or underscore. Then use letters, numbers, dashes or underscores, up to 32 characters.',
	root:
		ROOT_RE.test(root.value) && !root.value.includes('..')
			? null
			: 'Use an absolute path with plain letters, numbers, dots, dashes and slashes, such as /var/www/html.'
}));

function errorFor(field: keyof typeof problems.value): string | null {
	return submitted.value ? problems.value[field] : null;
}

// the public key is for these exact values; changing one means a new key
const matchesCredential = computed(
	() =>
		props.credential !== null &&
		props.credential.host === host.value.trim() &&
		props.credential.port === portNumber() &&
		props.credential.username === username.value
);

const expiry = computed(() =>
	props.credential ? new Date(props.credential.expiresAt).toLocaleString() : ''
);

function submit(): void {
	submitted.value = true;
	const parsedPort = portNumber();
	if (parsedPort === null || props.busy) return;
	if (Object.values(problems.value).some((problem) => problem !== null)) return;
	emit('submit', {
		host: host.value.trim(),
		port: parsedPort,
		username: username.value,
		root: root.value
	});
}

async function copyKey(): Promise<void> {
	if (!props.credential) return;
	try {
		await navigator.clipboard.writeText(props.credential.publicKey);
		copyState.value = 'copied';
	} catch {
		copyState.value = 'failed';
	}
}
</script>

<template>
	<div class="flex flex-col gap-6">
		<form
			class="flex flex-col gap-6"
			@submit.prevent="submit"
		>
			<UiField
				id="import-host"
				label="Host Name or Address"
				hint="The address Drupflare connects to. Addresses on a private network are refused."
				:error="errorFor('host')"
			>
				<template #default="{ describedBy }">
					<input
						id="import-host"
						v-model="host"
						type="text"
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"
						:aria-describedby="describedBy"
						:aria-invalid="errorFor('host') ? 'true' : undefined"
						class="w-full rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:ring-2 focus-visible:ring-primary"
					/>
				</template>
			</UiField>

			<UiField
				id="import-port"
				label="SSH Port"
				hint="Port 22 unless your server uses another."
				:error="errorFor('port')"
			>
				<template #default="{ describedBy }">
					<input
						id="import-port"
						v-model="port"
						type="text"
						inputmode="numeric"
						autocomplete="off"
						:aria-describedby="describedBy"
						:aria-invalid="errorFor('port') ? 'true' : undefined"
						class="w-32 rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:ring-2 focus-visible:ring-primary"
					/>
				</template>
			</UiField>

			<UiField
				id="import-user"
				label="User Name"
				hint="The account on your server that owns the Drupal files."
				:error="errorFor('username')"
			>
				<template #default="{ describedBy }">
					<input
						id="import-user"
						v-model="username"
						type="text"
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"
						:aria-describedby="describedBy"
						:aria-invalid="errorFor('username') ? 'true' : undefined"
						class="w-full rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:ring-2 focus-visible:ring-primary"
					/>
				</template>
			</UiField>

			<UiField
				id="import-root"
				label="Drupal Folder"
				hint="The absolute path where Drupal lives on the server, such as /var/www/html."
				:error="errorFor('root')"
			>
				<template #default="{ describedBy }">
					<input
						id="import-root"
						v-model="root"
						type="text"
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"
						:aria-describedby="describedBy"
						:aria-invalid="errorFor('root') ? 'true' : undefined"
						class="w-full rounded-md border border-default bg-default px-3 py-2 font-mono text-default focus-visible:ring-2 focus-visible:ring-primary"
					/>
				</template>
			</UiField>

			<p
				v-if="error"
				role="alert"
				class="text-sm text-red-700 dark:text-red-400"
			>
				{{ error }}
			</p>

			<div>
				<UButton
					type="submit"
					color="primary"
					variant="solid"
					:loading="busy"
					:disabled="busy"
				>
					Create the Public Key
				</UButton>
			</div>
		</form>

		<section
			v-if="credential"
			class="flex flex-col gap-4 rounded-lg border border-default p-5"
		>
			<h3 class="text-base font-semibold text-highlighted">Public Key</h3>
			<p class="text-sm text-default">
				Add this line to the authorized_keys file of that user on your server. We use it
				once and delete it.
			</p>
			<code
				class="break-all rounded-md bg-elevated px-3 py-2 text-sm text-highlighted select-all"
				>{{ credential.publicKey }}</code
			>
			<div class="flex flex-wrap items-center gap-3">
				<UButton
					color="neutral"
					variant="outline"
					icon="i-lucide-copy"
					@click="copyKey()"
				>
					Copy the Public Key
				</UButton>
				<span
					role="status"
					class="text-sm text-muted"
				>
					<template v-if="copyState === 'copied'">Copied</template>
					<template v-else-if="copyState === 'failed'"
						>Copy Failed. Select the key and copy it.</template
					>
				</span>
			</div>
			<p class="text-sm text-muted">
				The key expires {{ expiry }}, 24 hours after it was made.
			</p>
			<div v-if="matchesCredential">
				<UButton
					color="primary"
					variant="solid"
					@click="emit('next')"
				>
					Next
				</UButton>
			</div>
			<p
				v-else
				class="text-sm text-amber-800 dark:text-amber-300"
			>
				The values above changed. Create the public key again before you continue.
			</p>
		</section>
	</div>
</template>
