<script setup lang="ts">
import { PRESET_DESCRIPTIONS } from '~/shared/access-copy';
import type { AccessPresetView, AccessRuleView } from '~/stores/access';

const props = defineProps<{
	rules: AccessRuleView[];
	presets: AccessPresetView[];
	busy: boolean;
}>();
const emit = defineEmits<{ remove: [ruleId: string] }>();

const pending = ref<string | null>(null);

function label(rule: AccessRuleView): string {
	return props.presets.find((preset) => preset.id === rule.preset)?.label ?? rule.preset;
}

function detail(rule: AccessRuleView): string {
	switch (rule.preset) {
		case 'email-invite':
			return `Invited: ${rule.values.join(', ')}`;
		case 'github-user':
		case 'gitlab-user':
			return `Named: ${rule.values.join(', ')}`;
		case 'github-org':
		case 'gitlab-group':
			return `Members of: ${rule.values.join(', ')}`;
		case 'review-link':
			return rule.expiresAt === null
				? 'Review link'
				: `Review link. Stops working on ${formatDate(rule.expiresAt)}.`;
		default:
			return PRESET_DESCRIPTIONS[rule.preset];
	}
}

function formatDate(time: number): string {
	return new Date(time).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	});
}

function creator(rule: AccessRuleView): string {
	const who = rule.createdBy.startsWith('key:') ? 'an API key' : 'a member';
	return `Created by ${who} on ${formatDate(rule.createdAt)}`;
}

function remove(ruleId: string): void {
	pending.value = null;
	emit('remove', ruleId);
}
</script>

<template>
	<ul
		v-if="rules.length > 0"
		class="rounded-lg border border-default"
	>
		<li
			v-for="rule in rules"
			:key="rule.id"
			class="flex flex-col gap-2 border-t border-default px-4 py-3 first:border-t-0 sm:flex-row sm:items-center"
			:data-rule="rule.id"
		>
			<div class="min-w-0 flex-1">
				<p class="font-medium">{{ label(rule) }}</p>
				<p class="text-sm text-default">{{ detail(rule) }}</p>
				<p class="text-sm text-muted">{{ creator(rule) }}</p>
				<div
					v-if="pending === rule.id"
					class="mt-2 flex flex-col gap-2"
				>
					<p class="text-sm text-muted">
						Visitors who got in through this rule lose access the next time the site
						checks its access list.
					</p>
					<div class="flex gap-3">
						<UButton
							color="error"
							size="sm"
							:loading="busy"
							@click="remove(rule.id)"
							>Remove Rule</UButton
						>
						<UButton
							color="neutral"
							variant="outline"
							size="sm"
							@click="pending = null"
							>Cancel</UButton
						>
					</div>
				</div>
			</div>
			<div v-if="pending !== rule.id">
				<UButton
					color="error"
					variant="outline"
					size="sm"
					icon="i-lucide-trash-2"
					@click="pending = rule.id"
					>Remove</UButton
				>
			</div>
		</li>
	</ul>
	<p
		v-else
		class="text-sm text-muted"
	>
		No rules here yet.
	</p>
</template>
