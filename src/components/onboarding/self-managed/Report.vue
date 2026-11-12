<script setup lang="ts">
import type { ProbeCapability, ProbeReport, ProbeStatus } from '~/shared/cloudflare-probe';

const props = defineProps<{ report: ProbeReport }>();
const emit = defineEmits<{ choose: [accountId: string] }>();

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
	unknown: 'Could not check'
};

const STATE_ICON: Record<ProbeCapability['state'], string> = {
	granted: 'i-lucide-circle-check',
	missing: 'i-lucide-circle-x',
	unknown: 'i-lucide-circle-help'
};

const status = computed(() => STATUS[props.report.status]);
const kindLabel = computed(() => {
	if (props.report.kind === 'user') return 'User token';
	if (props.report.kind === 'account') return 'Account token';
	return null;
});
const multipleAccounts = computed(() => props.report.accounts.length > 1);
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
					v-else-if="row.state === 'unknown' && row.retryHint"
					class="pl-6 text-sm text-muted"
				>
					{{ row.retryHint }}
				</p>
			</li>
		</ul>

		<p class="text-sm text-muted">
			Drupflare ran these checks and saved nothing. The token is not stored.
		</p>
	</section>
</template>
