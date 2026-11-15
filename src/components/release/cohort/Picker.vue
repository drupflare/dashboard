<script setup lang="ts">
import type { RingName, RolloutChoices } from '~/stores/releases';

export interface PickerSite {
	id: string;
	name: string;
}

const props = defineProps<{ sites: PickerSite[]; modelValue: RolloutChoices }>();
const emit = defineEmits<{ 'update:modelValue': [value: RolloutChoices] }>();

const ROLES = [
	{ label: 'Usual rules', value: 'none' },
	{ label: 'Test site', value: 'synthetic' },
	{ label: 'Our own site', value: 'own' },
	{ label: 'Early adopter', value: 'canary' }
] as const;
type Role = (typeof ROLES)[number]['value'];

const RINGS: { label: string; value: RingName | 'auto' }[] = [
	{ label: 'Automatic', value: 'auto' },
	...(['R0', 'R1', 'R2', 'R3', 'R4', 'R5'] as const).map((ring) => ({
		label: `Ring ${ring.slice(1)}`,
		value: ring
	}))
];

const roleOf = (id: string): Role =>
	props.modelValue.designations.synthetic.includes(id)
		? 'synthetic'
		: props.modelValue.designations.own.includes(id)
			? 'own'
			: props.modelValue.designations.canary.includes(id)
				? 'canary'
				: 'none';

const ringOf = (id: string): RingName | 'auto' =>
	props.modelValue.overrides.find((entry) => entry.siteId === id)?.ring ?? 'auto';

function setRole(id: string, role: Role): void {
	const without = (list: string[]) => list.filter((entry) => entry !== id);
	const { synthetic, own, canary } = props.modelValue.designations;
	emit('update:modelValue', {
		...props.modelValue,
		designations: {
			synthetic: role === 'synthetic' ? [...without(synthetic), id] : without(synthetic),
			own: role === 'own' ? [...without(own), id] : without(own),
			canary: role === 'canary' ? [...without(canary), id] : without(canary)
		}
	});
}

// an admin may place a site in any ring, including the first
function setRing(id: string, ring: RingName | 'auto'): void {
	const rest = props.modelValue.overrides.filter((entry) => entry.siteId !== id);
	emit('update:modelValue', {
		...props.modelValue,
		overrides: ring === 'auto' ? rest : [...rest, { siteId: id, ring }]
	});
}

const selectClass =
	'rounded-md border border-default bg-default px-2 py-1 text-sm text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
</script>

<template>
	<fieldset class="flex flex-col gap-3">
		<legend class="text-sm font-medium text-highlighted">Where Each Site Goes</legend>
		<p class="text-sm text-muted">
			Sites without a choice are placed by the usual rules. An admin can place a site in any
			ring.
		</p>
		<p
			v-if="sites.length === 0"
			class="text-sm text-muted"
		>
			There are no sites to place.
		</p>
		<ul
			v-else
			class="flex max-h-72 flex-col gap-2 overflow-y-auto"
		>
			<li
				v-for="site in sites"
				:key="site.id"
				class="flex flex-wrap items-center justify-between gap-2"
			>
				<span class="text-sm text-default">{{ site.name }}</span>
				<span class="flex flex-wrap gap-2">
					<select
						:class="selectClass"
						:aria-label="`Role of ${site.name}`"
						:value="roleOf(site.id)"
						@change="
							setRole(site.id, ($event.target as HTMLSelectElement).value as Role)
						"
					>
						<option
							v-for="role in ROLES"
							:key="role.value"
							:value="role.value"
						>
							{{ role.label }}
						</option>
					</select>
					<select
						:class="selectClass"
						:aria-label="`Ring of ${site.name}`"
						:value="ringOf(site.id)"
						@change="
							setRing(
								site.id,
								($event.target as HTMLSelectElement).value as RingName | 'auto'
							)
						"
					>
						<option
							v-for="ring in RINGS"
							:key="ring.value"
							:value="ring.value"
						>
							{{ ring.label }}
						</option>
					</select>
				</span>
			</li>
		</ul>
	</fieldset>
</template>
