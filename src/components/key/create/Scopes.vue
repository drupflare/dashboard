<script setup lang="ts">
import { scopeSections } from '~/shared/api-keys';

const props = defineProps<{ offered: readonly string[] }>();
const selected = defineModel<string[]>({ required: true });

const sections = computed(() => scopeSections(props.offered));

const count = (choices: { action: string }[]) =>
	choices.filter((choice) => selected.value.includes(choice.action)).length;

function toggle(action: string, on: boolean): void {
	selected.value = on
		? [...selected.value, action]
		: selected.value.filter((item) => item !== action);
}
</script>

<template>
	<div class="flex flex-col gap-2">
		<details
			v-for="section in sections"
			:key="section.id"
			class="rounded-md border border-default"
		>
			<summary class="flex cursor-pointer items-center justify-between gap-3 px-3 py-2">
				<span class="font-medium text-highlighted">{{ section.title }}</span>
				<span class="text-sm text-muted"
					>{{ count(section.choices) }} of {{ section.choices.length }} selected</span
				>
			</summary>
			<ul class="flex flex-col gap-1 border-t border-default px-3 py-2">
				<li
					v-for="choice in section.choices"
					:key="choice.action"
				>
					<label class="flex items-start gap-2 text-sm text-default">
						<input
							type="checkbox"
							class="mt-0.5 size-4 shrink-0"
							:checked="selected.includes(choice.action)"
							@change="
								toggle(choice.action, ($event.target as HTMLInputElement).checked)
							"
						/>
						<span>{{ choice.label }}</span>
					</label>
				</li>
			</ul>
		</details>
		<p
			v-if="sections.length === 0"
			class="text-sm text-muted"
		>
			Your role has no permissions a key can hold.
		</p>
	</div>
</template>
