<script setup lang="ts">
import { IMPORT_TEMPLATE, kindFor } from '~/composables/useOnboarding';

interface TemplateChoice {
	id: string;
	name: string;
	category: 'cms' | 'workers' | null;
	free: boolean;
	enabled: boolean;
	comingSoon: string | null;
}

// undefined means the plan is not known, and then the server decides
const props = defineProps<{ templates: TemplateChoice[]; paidAllowed?: boolean }>();
const selected = defineModel<string>({ required: true });

const GROUPS = [
	{ category: 'cms', title: 'CMS' },
	{ category: 'workers', title: 'Custom Code' }
] as const;

const blocked = (template: TemplateChoice): boolean =>
	!template.free && props.paidAllowed === false;

// a choice shows only when create or import can take it and the plan allows it
function choosable(template: TemplateChoice): boolean {
	const creates = kindFor(template.id) !== null || template.id === IMPORT_TEMPLATE;
	return template.enabled && creates && !blocked(template);
}

function unavailableLabel(template: TemplateChoice): string {
	if (!template.enabled) return template.comingSoon ?? 'Coming Soon';
	return blocked(template) ? 'Needs a Paid Plan' : 'Not Available Yet';
}

const chosen = computed(() => props.templates.find((t) => t.id === selected.value) ?? null);
</script>

<template>
	<div class="flex flex-col gap-6">
		<fieldset
			v-for="group in GROUPS"
			:key="group.category"
			class="flex flex-col gap-3"
		>
			<legend class="mb-2 text-sm font-medium text-default">{{ group.title }}</legend>
			<label
				v-for="template in templates.filter((t) => t.category === group.category)"
				:key="template.id"
				:for="`template-${template.id}`"
				class="flex cursor-pointer items-start gap-3 rounded-lg border border-default p-4 has-checked:border-brand-600 has-checked:bg-muted has-disabled:cursor-default has-disabled:opacity-70 dark:has-checked:border-brand-400"
			>
				<input
					:id="`template-${template.id}`"
					v-model="selected"
					type="radio"
					name="template"
					:value="template.id"
					:disabled="!choosable(template)"
					class="mt-1 size-4 accent-primary"
				/>
				<span class="flex flex-col gap-1">
					<span class="font-medium text-highlighted">{{ template.name }}</span>
					<span
						v-if="!template.free"
						class="inline-flex items-center gap-1.5 text-sm text-amber-800 dark:text-amber-300"
					>
						<UIcon
							name="i-lucide-tag"
							class="size-4"
							aria-hidden="true"
						/>
						Paid
					</span>
					<span
						v-if="!choosable(template)"
						class="inline-flex items-center gap-1.5 text-sm text-muted"
					>
						<UIcon
							name="i-lucide-clock"
							class="size-4"
							aria-hidden="true"
						/>
						{{ unavailableLabel(template) }}
					</span>
				</span>
			</label>
		</fieldset>
		<p
			v-if="chosen && !chosen.free"
			class="text-sm text-muted"
		>
			{{ chosen.name }} needs a paid plan. Your plan is checked when you create the site.
		</p>
	</div>
</template>
