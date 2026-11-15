<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import type { AccessPresetId } from '~/shared/access-presets';
import {
	useAccessStore,
	type AccessPresetView,
	type AddRuleBody,
	type AddRuleResult,
	type EnvironmentView
} from '~/stores/access';

const props = defineProps<{
	orgId: string;
	siteId: string;
	presets: AccessPresetView[];
	environments: EnvironmentView[];
	inviteeLimit: number | null;
}>();
const emit = defineEmits<{ added: [result: AddRuleResult] }>();

const access = useAccessStore();

const VALUE_FIELDS: Partial<Record<AccessPresetId, { label: string; help: string }>> = {
	'email-invite': {
		label: 'Email Addresses',
		help: 'One per line or separated by commas.'
	},
	'github-user': { label: 'GitHub Usernames', help: 'One per line or separated by commas.' },
	'gitlab-user': { label: 'GitLab Usernames', help: 'One per line or separated by commas.' },
	'github-org': { label: 'GitHub Organisations', help: 'One per line or separated by commas.' },
	'gitlab-group': { label: 'GitLab Groups', help: 'One per line or separated by commas.' }
};

const DEFAULT_HOURS = 168;
const MAX_HOURS = 720;

const environment = ref('prod');
const preset = ref<AccessPresetId | null>(null);
const valueText = ref('');
const password = ref('');
const hours = ref<number>(DEFAULT_HOURS);
const busy = ref(false);
const error = ref<string | null>(null);
const revealed = ref<
	| { kind: 'password'; value: string }
	| { kind: 'link'; value: string; expiresAt: number | null }
	| null
>(null);

const available = computed(() => props.presets.filter((item) => item.available));
const selected = computed(() => preset.value ?? available.value[0]?.id ?? null);
const valueField = computed(() => (selected.value ? VALUE_FIELDS[selected.value] : undefined));
const environmentOptions = computed(() => [
	{ value: 'prod', label: 'Production' },
	...props.environments.map((item) => ({ value: item.id, label: item.name }))
]);

function values(): string[] {
	return valueText.value
		.split(/[\n,]/)
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

function bodyFor(): AddRuleBody | string {
	const kind = selected.value;
	if (kind === null) return 'Choose an access type.';
	const body: AddRuleBody = { environment: environment.value, preset: kind };
	if (VALUE_FIELDS[kind]) {
		const list = values();
		if (list.length === 0) return 'Add at least one name or address for this access type.';
		return { ...body, values: list };
	}
	if (kind === 'password') {
		if (password.value.length < 8) return 'Use at least 8 characters.';
		return { ...body, password: password.value };
	}
	if (kind === 'review-link') {
		if (!Number.isInteger(hours.value) || hours.value < 1 || hours.value > MAX_HOURS) {
			return `Choose between 1 and ${MAX_HOURS} hours.`;
		}
		return { ...body, expiresInHours: hours.value };
	}
	return body;
}

async function submit(): Promise<void> {
	error.value = null;
	const body = bodyFor();
	if (typeof body === 'string') {
		error.value = body;
		return;
	}
	busy.value = true;
	try {
		const result = await access.addRule(props.orgId, props.siteId, body);
		if (result.linkToken !== undefined) {
			revealed.value = {
				kind: 'link',
				value: result.linkToken,
				expiresAt: result.rule?.expiresAt ?? null
			};
		} else if (body.password !== undefined) {
			revealed.value = { kind: 'password', value: body.password };
		}
		valueText.value = '';
		password.value = '';
		emit('added', result);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}

function dismiss(): void {
	revealed.value = null;
}

function formatExpiry(time: number | null): string {
	if (time === null) return '';
	return new Date(time).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	});
}
</script>

<template>
	<div class="flex flex-col gap-4">
		<section
			v-if="revealed"
			class="flex flex-col gap-3 rounded-lg border border-warning p-4"
			aria-label="One-Time Secret"
		>
			<p class="flex items-start gap-1.5 text-sm text-warning">
				<UIcon
					name="i-lucide-triangle-alert"
					class="mt-0.5 size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>Copy this now. It will not be shown again.</span>
			</p>
			<template v-if="revealed.kind === 'password'">
				<p class="text-sm text-default">Shared password</p>
				<code
					data-secret
					class="break-all rounded-md bg-elevated px-3 py-2 text-sm text-highlighted select-all"
					>{{ revealed.value }}</code
				>
			</template>
			<template v-else>
				<p class="text-sm text-default">
					Review link token.
					<template v-if="revealed.expiresAt !== null"
						>Stops working on {{ formatExpiry(revealed.expiresAt) }}.</template
					>
				</p>
				<code
					data-secret
					class="break-all rounded-md bg-elevated px-3 py-2 text-sm text-highlighted select-all"
					>{{ revealed.value }}</code
				>
			</template>
			<div>
				<UButton
					color="neutral"
					variant="outline"
					@click="dismiss"
					>Done</UButton
				>
			</div>
		</section>

		<form
			class="flex flex-col gap-4"
			@submit.prevent="submit"
		>
			<label class="flex flex-col gap-1.5 text-sm">
				<span class="font-medium">Environment</span>
				<select
					v-model="environment"
					class="rounded-md border border-default bg-default px-3 py-2"
				>
					<option
						v-for="option in environmentOptions"
						:key="option.value"
						:value="option.value"
					>
						{{ option.label }}
					</option>
				</select>
			</label>

			<label class="flex flex-col gap-1.5 text-sm">
				<span class="font-medium">Access Type</span>
				<select
					:value="selected"
					class="rounded-md border border-default bg-default px-3 py-2"
					@change="preset = ($event.target as HTMLSelectElement).value as AccessPresetId"
				>
					<option
						v-for="item in presets"
						:key="item.id"
						:value="item.id"
						:disabled="!item.available"
					>
						{{
							item.available
								? item.label
								: `${item.label} (Needs the ${item.unlockedBy} plan)`
						}}
					</option>
				</select>
			</label>

			<label
				v-if="valueField"
				class="flex flex-col gap-1.5 text-sm"
			>
				<span class="font-medium">{{ valueField.label }}</span>
				<textarea
					v-model="valueText"
					rows="3"
					class="rounded-md border border-default bg-default px-3 py-2"
				></textarea>
				<span class="text-muted">{{ valueField.help }}</span>
				<span
					v-if="selected === 'email-invite' && inviteeLimit !== null"
					class="text-muted"
				>
					Your plan allows {{ inviteeLimit }} invited email addresses per site.
				</span>
			</label>

			<label
				v-if="selected === 'password'"
				class="flex flex-col gap-1.5 text-sm"
			>
				<span class="font-medium">Password</span>
				<input
					v-model="password"
					type="password"
					autocomplete="new-password"
					class="rounded-md border border-default bg-default px-3 py-2"
				/>
				<span class="text-muted"
					>At least 8 characters. Shown once after you add the rule.</span
				>
			</label>

			<label
				v-if="selected === 'review-link'"
				class="flex flex-col gap-1.5 text-sm"
			>
				<span class="font-medium">Hours Until Expiry</span>
				<input
					v-model.number="hours"
					type="number"
					min="1"
					:max="MAX_HOURS"
					class="rounded-md border border-default bg-default px-3 py-2"
				/>
				<span class="text-muted"
					>The link stops working after this many hours. Up to {{ MAX_HOURS }}.</span
				>
			</label>

			<p
				v-if="error"
				role="alert"
				class="text-sm text-error"
			>
				{{ error }}
			</p>

			<div>
				<UButton
					type="submit"
					:loading="busy"
					:disabled="selected === null"
					>Add Rule</UButton
				>
			</div>
		</form>
	</div>
</template>
