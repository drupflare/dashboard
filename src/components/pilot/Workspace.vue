<script setup lang="ts">
import { OBSERVATION_KINDS, PILOT_DECISIONS, type PilotView } from '~/shared/pilots';
import { usePilotsStore } from '~/stores/pilots';

const props = defineProps<{
	orgId: string;
	pilot: PilotView;
	sites: { id: string; name: string }[];
	canManage: boolean;
}>();

const pilots = usePilotsStore();

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:outline-2 focus-visible:outline-primary';

const kindLabels: Record<string, string> = {
	exception: 'Exception',
	failure: 'Failure',
	unsupported: 'Unsupported',
	'manual-work': 'Manual Work',
	note: 'Note'
};

// shown as a template only; the owner writes the line and nothing is saved from this text
const successTemplate =
	'Write the outcome the pilot must reach, the number it must beat and the date it is judged.';

const selected = ref<string[]>([...props.pilot.siteIds]);
const observation = reactive({ kind: 'note' as string, minutes: '', text: '' });
const decision = reactive({ decision: 'continue' as string, cost: '' });
const criteria = ref(props.pilot.successCriteria);

watch(
	() => props.pilot,
	(next) => {
		selected.value = [...next.siteIds];
		criteria.value = next.successCriteria;
	}
);

const decided = computed(() => props.pilot.decision !== null);

async function saveCriteria() {
	await pilots.edit(props.orgId, props.pilot.id, { successCriteria: criteria.value });
}

async function saveSites() {
	await pilots.setSites(props.orgId, props.pilot.id, selected.value);
}

async function addObservation() {
	const minutes = observation.minutes === '' ? null : Number(observation.minutes);
	const ok = await pilots.addObservation(props.orgId, props.pilot.id, {
		kind: observation.kind as (typeof OBSERVATION_KINDS)[number],
		minutes,
		text: observation.text
	});
	if (ok) {
		observation.minutes = '';
		observation.text = '';
	}
}

async function recordDecision() {
	const cost = decision.cost === '' ? null : Math.round(Number(decision.cost) * 100);
	await pilots.decide(props.orgId, props.pilot.id, {
		decision: decision.decision as (typeof PILOT_DECISIONS)[number],
		continuationCostCents: cost
	});
}
</script>

<template>
	<div class="space-y-8">
		<section class="space-y-3">
			<h2 class="font-semibold text-default">Success Criteria</h2>
			<p class="text-sm text-muted">{{ successTemplate }}</p>
			<textarea
				v-model="criteria"
				rows="4"
				:class="inputClass"
				:disabled="!canManage || decided"
				aria-label="Success criteria"
			/>
			<button
				v-if="canManage && !decided"
				type="button"
				class="rounded-md border border-default px-3 py-2 text-default"
				:disabled="pilots.saving"
				@click="saveCriteria"
			>
				Save Criteria
			</button>
		</section>

		<section class="space-y-3">
			<h2 class="font-semibold text-default">Sites in the Pilot</h2>
			<p
				v-if="sites.length === 0"
				class="text-muted"
			>
				No sites are in this organisation yet.
			</p>
			<ul
				v-else
				class="space-y-1"
			>
				<li
					v-for="site in sites"
					:key="site.id"
				>
					<label class="flex items-center gap-2 text-default">
						<input
							v-model="selected"
							type="checkbox"
							:value="site.id"
							:disabled="!canManage || decided"
						/>
						{{ site.name }}
					</label>
				</li>
			</ul>
			<button
				v-if="canManage && !decided"
				type="button"
				class="rounded-md border border-default px-3 py-2 text-default"
				:disabled="pilots.saving"
				@click="saveSites"
			>
				Save Sites
			</button>
		</section>

		<section class="space-y-3">
			<h2 class="font-semibold text-default">Record an Observation</h2>
			<form
				v-if="canManage && !decided"
				class="grid gap-3 sm:grid-cols-3"
				@submit.prevent="addObservation"
			>
				<label class="space-y-1">
					<span class="text-sm text-muted">Kind</span>
					<select
						v-model="observation.kind"
						:class="inputClass"
					>
						<option
							v-for="kind in OBSERVATION_KINDS"
							:key="kind"
							:value="kind"
						>
							{{ kindLabels[kind] }}
						</option>
					</select>
				</label>
				<label class="space-y-1">
					<span class="text-sm text-muted">Minutes</span>
					<input
						v-model="observation.minutes"
						type="number"
						min="0"
						:class="inputClass"
					/>
				</label>
				<label class="space-y-1 sm:col-span-3">
					<span class="text-sm text-muted">What Happened</span>
					<textarea
						v-model="observation.text"
						rows="2"
						:class="inputClass"
						required
					/>
				</label>
				<button
					type="submit"
					class="justify-self-start rounded-md border border-default px-3 py-2 text-default"
					:disabled="pilots.saving"
				>
					Add Observation
				</button>
			</form>
		</section>

		<section class="space-y-3">
			<h2 class="font-semibold text-default">Decision</h2>
			<p
				v-if="decided"
				class="text-default"
			>
				Decided: {{ pilot.decision
				}}<span v-if="pilot.decidedAt"> on {{ pilot.decidedAt }}</span
				>.
			</p>
			<form
				v-else-if="canManage"
				class="grid gap-3 sm:grid-cols-3"
				@submit.prevent="recordDecision"
			>
				<label class="space-y-1">
					<span class="text-sm text-muted">Decision</span>
					<select
						v-model="decision.decision"
						:class="inputClass"
					>
						<option
							v-for="choice in PILOT_DECISIONS"
							:key="choice"
							:value="choice"
						>
							{{ choice }}
						</option>
					</select>
				</label>
				<label class="space-y-1">
					<span class="text-sm text-muted">Cost to Continue, in Dollars</span>
					<input
						v-model="decision.cost"
						type="number"
						min="0"
						step="0.01"
						:class="inputClass"
					/>
				</label>
				<button
					type="submit"
					class="justify-self-start rounded-md border border-default px-3 py-2 text-default"
					:disabled="pilots.saving"
				>
					Record Decision
				</button>
			</form>
		</section>
	</div>
</template>
