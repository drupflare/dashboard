<script setup lang="ts">
import type { SettingsField } from '~/stores/site-config';
import ConfigWidgetColor from './widget/Color.vue';
import ConfigWidgetJson from './widget/Json.vue';
import ConfigWidgetLever from './widget/Lever.vue';
import ConfigWidgetPermissionMatrix from './widget/PermissionMatrix.vue';
import ConfigWidgetRateLimit from './widget/RateLimit.vue';

const props = defineProps<{
	field: SettingsField;
	// undefined: no edit in progress; null: clear the override
	draft?: unknown;
	error?: string | null;
}>();
const emit = defineEmits<{ edit: [value: string | number | null]; check: [] }>();

const edited = computed(() => props.draft !== undefined);
const current = computed(() => (edited.value ? props.draft : props.field.value));
const options = computed(() => {
	const values = props.field.schema['enum'];
	return Array.isArray(values) ? values.map(String) : [];
});
const isFlag = computed(() => options.value.length === 2 && options.value[0] === '0');
const isInteger = computed(() => props.field.schema['type'] === 'integer');
const isJson = computed(() => props.field.widget === 'json');
const inputText = computed(() =>
	current.value === null || current.value === undefined ? '' : String(current.value)
);

function typed(text: string): void {
	if (text.trim() === '') return emit('edit', null);
	emit('edit', isInteger.value ? Number(text) : text);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === 'object' && !Array.isArray(v);

// a widget the dashboard does not know, or a value of the wrong shape, falls back to formatted JSON
const widget = computed(() => {
	const { widget: name, value } = props.field;
	if (name === 'color') return ConfigWidgetColor;
	if (name === 'lever-slider' && (typeof value === 'number' || value === null))
		return ConfigWidgetLever;
	if (name === 'rate-limit') return ConfigWidgetRateLimit;
	if (name === 'permission-matrix' && isPlainObject(value)) return ConfigWidgetPermissionMatrix;
	return null;
});

// a secret never shows its value, only whether one is set
const plain = computed(() => {
	const { widget: name, value } = props.field;
	if (name === 'secret') {
		return value === null || value === undefined || value === 'Not Set' ? 'Not Set' : 'Set';
	}
	if (name === 'toggle') return value === '1' ? 'On' : value === '0' ? 'Off' : 'Not Set';
	if (value === null || value === undefined || value === '') return 'Not Set';
	return String(value);
});

const scalar = computed(() => {
	const v = props.field.value;
	return v === null || v === undefined || typeof v !== 'object';
});
const showPlain = computed(
	() =>
		props.field.widget === 'secret' ||
		props.field.widget === 'toggle' ||
		(widget.value === null && scalar.value)
);
</script>

<template>
	<div class="flex flex-col gap-2 border-b border-default py-4 last:border-0">
		<div class="flex flex-wrap items-center gap-2">
			<h3 class="text-sm font-medium">{{ field.label }}</h3>
			<UBadge
				v-if="field.danger"
				color="error"
				variant="subtle"
				size="sm"
			>
				<UIcon
					name="i-lucide-triangle-alert"
					class="size-3.5"
				/>
				Danger
			</UBadge>
			<SiteConfigProvenance :provenance="field.provenance" />
			<span
				v-if="!field.editable"
				class="inline-flex items-center gap-1 text-xs text-muted"
			>
				<UIcon
					name="i-lucide-lock"
					class="size-3.5"
				/>
				Read Only
			</span>
		</div>
		<p
			v-if="field.description"
			class="text-xs text-muted"
		>
			{{ field.description }}
		</p>
		<div
			v-if="field.editable"
			class="flex flex-col gap-2"
		>
			<USwitch
				v-if="isFlag"
				:model-value="current === '1'"
				:label="current === '1' ? 'On' : 'Off'"
				@update:model-value="emit('edit', $event ? '1' : '0')"
			/>
			<USelect
				v-else-if="options.length > 0"
				:model-value="inputText"
				:items="options"
				class="w-64"
				@update:model-value="emit('edit', String($event))"
			/>
			<UTextarea
				v-else-if="isJson"
				:model-value="inputText"
				:rows="4"
				class="font-mono"
				@update:model-value="typed(String($event))"
				@blur="emit('check')"
			/>
			<UInput
				v-else
				:model-value="inputText"
				:type="isInteger ? 'number' : 'text'"
				class="w-64"
				:aria-label="field.label"
				:aria-invalid="error ? 'true' : undefined"
				@update:model-value="typed(String($event))"
				@blur="emit('check')"
			/>
			<p
				v-if="error"
				role="alert"
				class="flex items-center gap-1 text-xs text-error"
			>
				<UIcon
					name="i-lucide-circle-alert"
					class="size-3.5"
				/>
				{{ error }}
			</p>
			<UButton
				v-if="field.provenance === 'kv' || edited"
				color="neutral"
				variant="link"
				size="xs"
				class="self-start px-0"
				@click="emit('edit', null)"
			>
				Use the Default
			</UButton>
		</div>
		<div v-else>
			<component
				:is="widget"
				v-if="widget"
				:value="field.value"
				:bounds="field.bounds"
				:schema="field.schema"
			/>
			<p
				v-else-if="showPlain"
				class="font-mono text-sm"
			>
				{{ plain }}
			</p>
			<ConfigWidgetJson
				v-else
				:value="field.value"
			/>
		</div>
		<p
			v-if="!field.editable && field.readOnlyReason"
			class="text-xs text-muted"
		>
			{{ field.readOnlyReason }}
		</p>
	</div>
</template>
