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

interface DrupalTemplate {
	id: string;
	name: string;
	summary: string;
	state: 'not_built' | 'building' | 'ready' | 'failed';
	advisories: { id: string; package: string }[];
	patchNotes: { package: string; patch: string }[];
	fit: { fits: boolean; rows: number; limit: number; percent: number } | null;
	usable: boolean;
	reason: string | null;
}

// undefined means the plan is not known, and then the server decides
const props = defineProps<{
	templates: TemplateChoice[];
	paidAllowed?: boolean;
	drupalTemplates?: DrupalTemplate[];
	freePlan?: boolean;
}>();
const selected = defineModel<string>({ required: true });
// null is Blank Drupal; a template id starts the site from that template
const entry = defineModel<string | null>('entry', { default: null });

// a template is refused when it is not ready, or when it does not fit the Free plan the site is on
const refusal = (template: DrupalTemplate): string | null => {
	if (!template.usable) return template.reason;
	return props.freePlan && template.fit && !template.fit.fits ? template.reason : null;
};

function advisoryNotice(template: DrupalTemplate): string | null {
	if (template.advisories.length === 0) return null;
	const core = template.advisories.filter((advisory) => advisory.package === 'drupal/core');
	const others = template.advisories.length - core.length;
	const named = core.map((advisory) => advisory.id).join(', ');
	const parts = [
		core.length > 0 ? `Its Drupal core has open security advisories (${named}).` : null,
		others > 0 ? `${others} more come from modules it includes.` : null,
		'Update Drupal right after you create the site.'
	];
	return parts.filter(Boolean).join(' ');
}

const gateNote = (template: DrupalTemplate): string | null => {
	if (!template.fit) return null;
	const rows = template.fit.rows.toLocaleString('en-US');
	return template.fit.fits
		? `Writes about ${rows} rows on first load, ${template.fit.percent}% of what the Free plan allows each day.`
		: `Writes about ${rows} rows on first load, more than the Free plan allows each day.`;
};

watch(selected, (id) => {
	if (id !== 'drupal') entry.value = null;
});

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
			<template
				v-for="template in templates.filter((t) => t.category === group.category)"
				:key="template.id"
			>
				<label
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
				<fieldset
					v-if="
						template.id === 'drupal' && selected === 'drupal' && drupalTemplates?.length
					"
					class="ml-7 flex flex-col gap-3"
				>
					<legend class="mb-2 text-sm font-medium text-default">Start From</legend>
					<label
						for="drupal-entry-blank"
						class="flex cursor-pointer items-start gap-3 rounded-lg border border-default p-4 has-checked:border-brand-600 has-checked:bg-muted dark:has-checked:border-brand-400"
					>
						<input
							id="drupal-entry-blank"
							v-model="entry"
							type="radio"
							name="drupal-entry"
							:value="null"
							class="mt-1 size-4 accent-primary"
						/>
						<span class="flex flex-col gap-1">
							<span class="font-medium text-highlighted">Blank Drupal</span>
							<span class="text-sm text-muted"
								>A new Drupal site with nothing added.</span
							>
						</span>
					</label>
					<label
						v-for="item in drupalTemplates"
						:key="item.id"
						:for="`drupal-entry-${item.id}`"
						class="flex cursor-pointer items-start gap-3 rounded-lg border border-default p-4 has-checked:border-brand-600 has-checked:bg-muted has-disabled:cursor-default has-disabled:opacity-70 dark:has-checked:border-brand-400"
					>
						<input
							:id="`drupal-entry-${item.id}`"
							v-model="entry"
							type="radio"
							name="drupal-entry"
							:value="item.id"
							:disabled="refusal(item) !== null"
							class="mt-1 size-4 accent-primary"
						/>
						<span class="flex flex-col gap-1">
							<span class="font-medium text-highlighted">{{ item.name }}</span>
							<span class="text-sm text-muted">{{ item.summary }}</span>
							<span
								v-if="refusal(item)"
								class="inline-flex items-center gap-1.5 text-sm text-muted"
							>
								<UIcon
									name="i-lucide-clock"
									class="size-4"
									aria-hidden="true"
								/>
								{{ refusal(item) }}
							</span>
							<span
								v-if="gateNote(item)"
								class="text-sm text-muted"
								>{{ gateNote(item) }}</span
							>
							<span
								v-if="advisoryNotice(item)"
								class="inline-flex items-start gap-1.5 text-sm text-amber-800 dark:text-amber-300"
							>
								<UIcon
									name="i-lucide-triangle-alert"
									class="mt-0.5 size-4 shrink-0"
									aria-hidden="true"
								/>
								{{ advisoryNotice(item) }}
							</span>
							<span
								v-for="note in item.patchNotes"
								:key="note.patch"
								class="text-sm text-muted"
							>
								A patch for {{ note.package }} did not apply, so that module runs
								unpatched.
							</span>
						</span>
					</label>
				</fieldset>
			</template>
		</fieldset>
		<p
			v-if="chosen && !chosen.free"
			class="text-sm text-muted"
		>
			{{ chosen.name }} needs a paid plan. Your plan is checked when you create the site.
		</p>
	</div>
</template>
