<script setup lang="ts">
import { nameProblem } from '~/composables/useOnboarding';
import { suggest } from '~/shared/names';
import { storageNote, type PlaneConnectionView } from '~/shared/plane-connections';
import type { SelfManagedSiteBody } from '~/stores/planes';

const props = defineProps<{
	connections: PlaneConnectionView[];
	busy: boolean;
	error?: string | null;
}>();
const emit = defineEmits<{ submit: [body: SelfManagedSiteBody] }>();

const KINDS = [
	{ value: 'drupal', label: 'Drupal' },
	{ value: 'nuxtpress', label: 'NuxtPress' },
	{ value: 'mylora', label: 'MyLora' }
] as const;

const ZONE_ID = /^[0-9a-f]{32}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const connectionId = ref(props.connections[0]?.id ?? '');
const kind = ref<SelfManagedSiteBody['kind']>('drupal');
const name = ref(suggest(crypto.randomUUID()));
const address = ref<'workers-dev' | 'own'>('workers-dev');
const hostname = ref('');
const zoneId = ref('');
const touched = ref(false);

watch(
	() => props.connections,
	(items) => {
		if (!items.some((item) => item.id === connectionId.value)) {
			connectionId.value = items[0]?.id ?? '';
		}
	}
);

const connection = computed(() => props.connections.find((item) => item.id === connectionId.value));
const note = computed(() =>
	connection.value === undefined ? null : storageNote(connection.value)
);
const subdomain = computed(() => connection.value?.workersSubdomain ?? null);

const nameError = computed(() => (touched.value ? nameProblem(name.value) : null));
const hostError = computed(() => {
	if (!touched.value || address.value !== 'own') return null;
	return HOSTNAME.test(hostname.value.trim().toLowerCase())
		? null
		: 'Enter a hostname such as www.example.org.';
});
const zoneError = computed(() => {
	if (!touched.value || address.value !== 'own') return null;
	return ZONE_ID.test(zoneId.value.trim())
		? null
		: 'The zone ID is 32 letters and numbers. Copy it from the zone overview in Cloudflare.';
});
const noSubdomain = computed(() => address.value === 'workers-dev' && subdomain.value === null);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:ring-2 focus-visible:ring-primary';

function submit(): void {
	touched.value = true;
	if (props.busy || connection.value === undefined) return;
	if (nameProblem(name.value) !== null || noSubdomain.value) return;
	if (address.value === 'own' && (hostError.value !== null || zoneError.value !== null)) {
		return;
	}
	const body: SelfManagedSiteBody = {
		kind: kind.value,
		name: name.value,
		connectionId: connectionId.value,
		...(address.value === 'own'
			? {
					customHost: {
						hostname: hostname.value.trim().toLowerCase(),
						zoneId: zoneId.value.trim()
					}
				}
			: {})
	};
	emit('submit', body);
}
</script>

<template>
	<form
		class="flex flex-col gap-6"
		@submit.prevent="submit"
	>
		<UiField
			v-if="connections.length > 1"
			id="self-managed-connection"
			label="Cloudflare Account"
		>
			<template #default="{ describedBy }">
				<select
					id="self-managed-connection"
					v-model="connectionId"
					:aria-describedby="describedBy"
					:class="inputClass"
				>
					<option
						v-for="item in connections"
						:key="item.id"
						:value="item.id"
					>
						{{ item.accountName }}
					</option>
				</select>
			</template>
		</UiField>
		<p
			v-else-if="connection"
			class="text-sm text-default"
		>
			Account: <span class="font-medium">{{ connection.accountName }}</span>
		</p>

		<UiField
			id="self-managed-kind"
			label="Site Type"
		>
			<template #default="{ describedBy }">
				<select
					id="self-managed-kind"
					v-model="kind"
					:aria-describedby="describedBy"
					:class="inputClass"
				>
					<option
						v-for="item in KINDS"
						:key="item.value"
						:value="item.value"
					>
						{{ item.label }}
					</option>
				</select>
			</template>
		</UiField>

		<UiField
			id="self-managed-name"
			label="Site Name"
			hint="We suggest three random words. You can change them."
			:error="nameError"
		>
			<template #default="{ describedBy }">
				<input
					id="self-managed-name"
					v-model="name"
					type="text"
					autocomplete="off"
					spellcheck="false"
					:aria-describedby="describedBy"
					:aria-invalid="nameError ? 'true' : undefined"
					:class="inputClass"
					@blur="touched = true"
				/>
			</template>
		</UiField>

		<fieldset class="flex flex-col gap-3">
			<legend class="text-sm font-medium text-default">Address</legend>
			<label class="flex items-start gap-2 text-sm text-default">
				<input
					v-model="address"
					type="radio"
					value="workers-dev"
					name="self-managed-address"
					class="mt-1"
				/>
				<span>
					Your Cloudflare Address
					<span class="block text-muted">
						<template v-if="subdomain">
							The site runs at an address ending in .{{ subdomain }}.workers.dev. Its
							full address is shown when the create finishes.
						</template>
						<template v-else>
							This account has no workers.dev subdomain yet. Set one in Cloudflare
							under Workers, or use your own domain.
						</template>
					</span>
				</span>
			</label>
			<label class="flex items-start gap-2 text-sm text-default">
				<input
					v-model="address"
					type="radio"
					value="own"
					name="self-managed-address"
					class="mt-1"
				/>
				<span>
					A Hostname on a Domain in This Account
					<span class="block text-muted">
						Drupflare adds one route to your zone and changes no other record.
					</span>
				</span>
			</label>
			<div
				v-if="address === 'own'"
				class="flex flex-col gap-4 pl-6"
			>
				<UiField
					id="self-managed-host"
					label="Hostname"
					:error="hostError"
				>
					<template #default="{ describedBy }">
						<input
							id="self-managed-host"
							v-model="hostname"
							type="text"
							autocomplete="off"
							spellcheck="false"
							placeholder="www.example.org"
							:aria-describedby="describedBy"
							:aria-invalid="hostError ? 'true' : undefined"
							:class="inputClass"
						/>
					</template>
				</UiField>
				<UiField
					id="self-managed-zone"
					label="Zone ID"
					:error="zoneError"
				>
					<template #default="{ describedBy }">
						<input
							id="self-managed-zone"
							v-model="zoneId"
							type="text"
							autocomplete="off"
							spellcheck="false"
							:aria-describedby="describedBy"
							:aria-invalid="zoneError ? 'true' : undefined"
							:class="`${inputClass} font-mono`"
						/>
					</template>
				</UiField>
			</div>
		</fieldset>

		<p
			v-if="note"
			class="text-sm text-muted"
		>
			{{ note }}
		</p>

		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>

		<div class="flex justify-end">
			<UButton
				type="submit"
				:loading="busy"
				:disabled="busy || noSubdomain"
			>
				Create
			</UButton>
		</div>
	</form>
</template>
