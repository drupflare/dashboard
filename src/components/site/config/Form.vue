<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { validate } from '~/shared/site-config/form';
import {
	conflictOf,
	useSiteConfigStore,
	type SettingChange,
	type SettingsConflict,
	type SettingsField,
	type SettingsGroup
} from '~/stores/site-config';

const props = defineProps<{
	groups: SettingsGroup[];
	orgId?: string;
	siteId?: string;
	etag?: string | null;
}>();

const emit = defineEmits<{ refresh: [] }>();
const store = useSiteConfigStore();

const fields = computed(() => props.groups.flatMap((group) => group.fields));
const byKey = computed(() => new Map(fields.value.map((field) => [field.key, field])));

// a key is in the drafts only while it differs from what the site held when the page loaded
const drafts = reactive<Record<string, string | number | null>>({});
const errors = reactive<Record<string, string>>({});
const confirmed = reactive<Record<string, boolean>>({});

function sameAsLoaded(field: SettingsField, value: string | number | null): boolean {
	const loaded = field.provenance === 'kv' ? field.value : null;
	return (value ?? null) === (loaded ?? null);
}

function edit(field: SettingsField, value: string | number | null): void {
	if (sameAsLoaded(field, value)) {
		delete drafts[field.key];
		delete errors[field.key];
		return;
	}
	drafts[field.key] = value;
}

// the registry fields carry their own schema, so the same check the server runs shows here
function check(key: string): void {
	const field = byKey.value.get(key);
	if (field === undefined || drafts[key] === undefined) return;
	const verdict = validate([{ key, schema: field.schema, writable: field.editable }] as never, {
		[key]: drafts[key]
	});
	if (verdict.ok) delete errors[key];
	else errors[key] = verdict.errors[0]?.message ?? 'This value is not valid.';
}

const changes = computed<SettingChange[]>(() =>
	Object.entries(drafts).map(([key, value]) => ({ key, value }))
);

watch(
	() => ({ ...drafts }),
	(now) => {
		for (const key of Object.keys(now)) check(key);
	}
);

const dangerous = computed(() =>
	changes.value.flatMap((change) => {
		const field = byKey.value.get(change.key);
		return field?.danger ? [field] : [];
	})
);
const valid = computed(() => changes.value.length > 0 && Object.keys(errors).length === 0);
const allConfirmed = computed(() =>
	dangerous.value.every((field) => confirmed[field.key] === true)
);

const reviewing = ref(false);
const applying = ref(false);
const failure = ref<string | null>(null);
const conflict = ref<SettingsConflict | null>(null);
let request: Promise<void> | null = null;

const rows = computed(() =>
	changes.value.map((change) => {
		const field = byKey.value.get(change.key);
		return {
			key: change.key,
			label: field?.label ?? change.key,
			before: field?.value ?? null,
			after: change.value,
			theirs: conflict.value ? (conflict.value.current[change.key] ?? null) : undefined
		};
	})
);

function discard(): void {
	for (const key of Object.keys(drafts)) delete drafts[key];
	for (const key of Object.keys(errors)) delete errors[key];
	for (const key of Object.keys(confirmed)) delete confirmed[key];
	reviewing.value = false;
	conflict.value = null;
	failure.value = null;
}

function useSiteValues(): void {
	discard();
	emit('refresh');
}

// one request in flight: a double click reuses the pending write and its key
function apply(etag?: string): void {
	request ??= send(etag ?? props.etag ?? null).finally(() => {
		request = null;
	});
}

async function send(etag: string | null): Promise<void> {
	if (props.orgId === undefined || props.siteId === undefined || etag === null) return;
	failure.value = null;
	applying.value = true;
	try {
		const operation = await store.write(
			props.orgId,
			props.siteId,
			etag,
			changes.value,
			crypto.randomUUID()
		);
		await navigateTo(`/new/progress/${operation.id}`);
	} catch (cause) {
		const error = toApiClientError(cause);
		const found = conflictOf(error);
		if (found !== null) conflict.value = found;
		else failure.value = error.message;
	} finally {
		applying.value = false;
	}
}
</script>

<template>
	<div class="flex flex-col gap-8">
		<section
			v-for="group in groups"
			:key="group.id"
			:aria-labelledby="`group-${group.id}`"
		>
			<h2
				:id="`group-${group.id}`"
				class="mb-1 text-base font-semibold"
			>
				{{ group.label }}
			</h2>
			<p
				v-if="group.fields.length === 0"
				class="py-4 text-sm text-muted"
			>
				No Settings in This Group
			</p>
			<SiteConfigField
				v-for="field in group.fields"
				:key="field.key"
				:field="field"
				:draft="drafts[field.key]"
				:error="errors[field.key]"
				@edit="edit(field, $event)"
				@check="check(field.key)"
			/>
		</section>

		<section
			v-if="changes.length > 0"
			class="flex flex-col gap-3 rounded-md border border-default p-4"
			aria-labelledby="review-heading"
		>
			<h2
				id="review-heading"
				class="text-base font-semibold"
			>
				{{ conflict ? 'The Site Changed Since You Opened This Page' : 'Your Changes' }}
			</h2>

			<template v-if="!reviewing && !conflict">
				<p class="text-sm text-muted">
					{{ changes.length }}
					{{ changes.length === 1 ? 'setting is' : 'settings are' }} ready to review.
				</p>
				<div class="flex gap-2">
					<UButton
						:disabled="!valid"
						@click="reviewing = true"
					>
						Review Changes
					</UButton>
					<UButton
						color="neutral"
						variant="outline"
						@click="discard()"
					>
						Discard Changes
					</UButton>
				</div>
				<p
					v-if="!valid && Object.keys(errors).length > 0"
					class="text-xs text-muted"
				>
					Fix the highlighted settings to review your changes.
				</p>
			</template>

			<template v-else>
				<SiteConfigDiff :rows="rows" />

				<div
					v-for="field in dangerous"
					:key="field.key"
					class="flex flex-col gap-1 rounded-md bg-error/10 p-3 text-sm"
				>
					<UCheckbox
						v-model="confirmed[field.key]"
						:label="`I understand what changing ${field.label} does`"
					/>
					<p
						v-if="field.description"
						class="text-xs text-muted"
					>
						{{ field.description }}
					</p>
				</div>

				<p
					v-if="failure"
					role="alert"
					class="text-sm text-error"
				>
					{{ failure }}
				</p>

				<div class="flex flex-wrap gap-2">
					<UButton
						:loading="applying"
						:disabled="applying || !allConfirmed"
						@click="apply(conflict ? conflict.etag : undefined)"
					>
						{{ conflict ? 'Keep My Changes' : 'Apply Changes' }}
					</UButton>
					<UButton
						color="neutral"
						variant="outline"
						@click="conflict ? useSiteValues() : (reviewing = false)"
					>
						{{ conflict ? 'Use the Site Values' : 'Keep Editing' }}
					</UButton>
				</div>
			</template>
		</section>
	</div>
</template>
