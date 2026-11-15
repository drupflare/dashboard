<script setup lang="ts">
import type { ProbeCapability, ProbeReport, ProbeStatus } from '~/shared/cloudflare-probe';

const props = defineProps<{ report: ProbeReport; connecting?: boolean }>();
const emit = defineEmits<{ choose: [accountId: string]; connect: [accountId: string] }>();

const chosen = ref(props.report.account?.id ?? '');

watch(
	() => props.report.account?.id,
	(id) => {
		chosen.value = id ?? '';
	}
);

const STATUS: Record<ProbeStatus, { icon: string; text: string }> = {
	active: { icon: 'i-lucide-circle-check', text: 'The token is active.' },
	expired: { icon: 'i-lucide-circle-x', text: 'The token has expired.' },
	disabled: { icon: 'i-lucide-circle-x', text: 'The token is turned off.' },
	invalid: { icon: 'i-lucide-circle-x', text: 'Cloudflare did not accept this token.' },
	unknown: {
		icon: 'i-lucide-circle-help',
		text: 'Cloudflare did not answer. Try again in a few minutes.'
	}
};

const STATE_TEXT: Record<ProbeCapability['state'], string> = {
	granted: 'Granted',
	missing: 'Missing',
	'not-enabled': 'Not turned on',
	unknown: 'Could not check'
};

const STATE_ICON: Record<ProbeCapability['state'], string> = {
	granted: 'i-lucide-circle-check',
	missing: 'i-lucide-circle-x',
	'not-enabled': 'i-lucide-circle-alert',
	unknown: 'i-lucide-circle-help'
};

const status = computed(() => STATUS[props.report.status]);
const kindLabel = computed(() => {
	if (props.report.kind === 'user') return 'User token';
	if (props.report.kind === 'account') return 'Account token';
	return null;
});
const multipleAccounts = computed(() => props.report.accounts.length > 1);

// a token that cannot edit Workers scripts cannot run a site, so it is never offered for storing
const scripts = computed(() => props.report.capabilities.find((row) => row.id === 'scripts'));
const activeAccount = computed(
	() => props.report.status === 'active' && props.report.account !== null
);
const connectable = computed(() => activeAccount.value && scripts.value?.state === 'granted');
const noScripts = computed(
	() => activeAccount.value && scripts.value !== undefined && scripts.value.state !== 'granted'
);
</script>

<template>
	<section
		class="flex flex-col gap-6 rounded-lg border border-default p-6"
		aria-labelledby="self-managed-report"
	>
		<div class="flex flex-col gap-2">
			<h2
				id="self-managed-report"
				class="text-lg font-semibold text-highlighted"
			>
				What This Token Can Do
			</h2>
			<p
				class="flex items-start gap-2 text-sm text-default"
				role="status"
			>
				<UIcon
					:name="status.icon"
					class="mt-0.5 size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>{{ status.text }}</span>
			</p>
			<p
				v-if="kindLabel"
				class="text-sm text-muted"
			>
				{{ kindLabel }}
				<template v-if="report.expiresOn">, expires {{ report.expiresOn }}</template>
			</p>
		</div>

		<div
			v-if="multipleAccounts"
			class="flex flex-col gap-2"
		>
			<label
				for="self-managed-account"
				class="text-sm font-medium text-default"
				>Account</label
			>
			<div class="flex flex-wrap items-center gap-3">
				<select
					id="self-managed-account"
					v-model="chosen"
					class="rounded-md border border-default bg-default px-3 py-2 text-sm text-default"
				>
					<option
						v-for="account in report.accounts"
						:key="account.id"
						:value="account.id"
					>
						{{ account.name }}
					</option>
				</select>
				<UButton
					variant="outline"
					:disabled="chosen === '' || chosen === report.account?.id"
					@click="emit('choose', chosen)"
				>
					Check This Account
				</UButton>
			</div>
		</div>

		<p
			v-else-if="report.account"
			class="text-sm text-default"
		>
			Checked account: {{ report.account.name }}
		</p>

		<p
			v-if="report.status === 'active' && report.accounts.length === 0"
			class="text-sm text-default"
		>
			This token cannot see any accounts, so there is nothing to check.
		</p>

		<ul
			v-if="report.capabilities.length > 0"
			class="flex flex-col gap-4"
		>
			<li
				v-for="row in report.capabilities"
				:key="row.id"
				class="flex flex-col gap-1"
			>
				<div class="flex items-start gap-2 text-sm">
					<UIcon
						:name="STATE_ICON[row.state]"
						class="mt-0.5 size-4 shrink-0"
						aria-hidden="true"
					/>
					<span class="font-medium text-highlighted">{{ row.label }}</span>
					<span class="text-muted">{{ STATE_TEXT[row.state] }}</span>
				</div>
				<p
					v-if="row.state === 'missing'"
					class="pl-6 text-sm text-muted"
				>
					Add the permission "{{ row.permission }}" to this token, then check again.
				</p>
				<p
					v-else-if="row.state === 'not-enabled'"
					class="pl-6 text-sm text-muted"
				>
					Object storage is not turned on for this account. Cloudflare asks for a payment
					card before it turns on, even when your use stays free. Add a card under
					Billing, turn on R2 in the Cloudflare dashboard, then check again. Until then
					your site runs without object storage, so the file mirror and Strata backups
					stay off.
				</p>
				<p
					v-else-if="row.state === 'unknown' && row.retryHint"
					class="pl-6 text-sm text-muted"
				>
					{{ row.retryHint }}
				</p>
			</li>
		</ul>

		<div
			v-if="connectable"
			class="flex flex-col gap-2"
		>
			<p class="text-sm text-default">
				<template v-if="report.canDownscope">
					This token can make other tokens, so Drupflare makes a narrower one for
					{{ report.account?.name }}, keeps only that one sealed, and does not keep this
					token.
				</template>
				<template v-else>
					Drupflare keeps this token sealed. It cannot make a narrower one, so the token
					keeps every permission you gave it.
				</template>
			</p>
			<div>
				<UButton
					:loading="props.connecting"
					:disabled="props.connecting"
					@click="emit('connect', report.account?.id ?? '')"
				>
					Connect This Account
				</UButton>
			</div>
		</div>
		<p
			v-else-if="noScripts"
			class="text-sm text-muted"
		>
			This token cannot edit Workers scripts, so it cannot be connected. Add the permission
			and check again.
		</p>

		<p class="text-sm text-muted">
			Nothing is saved until you connect the account. Checking a token stores nothing.
		</p>
	</section>
</template>
