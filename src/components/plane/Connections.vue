<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import type { PlaneConnectionView } from '~/shared/plane-connections';
import { usePlanesStore } from '~/stores/planes';

const props = defineProps<{ orgId: string }>();

const planes = usePlanesStore();
const checking = ref<string | null>(null);
const checkError = ref<string | null>(null);

const items = computed(() => planes.connections.get(props.orgId));

const STATE: Record<
	PlaneConnectionView['state'],
	{ label: string; color: 'success' | 'warning' | 'neutral' }
> = {
	active: { label: 'Active', color: 'success' },
	invalid: { label: 'Needs Attention', color: 'warning' },
	revoked: { label: 'Revoked', color: 'neutral' }
};

const when = (millis: number) =>
	new Date(millis).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const granted = (item: PlaneConnectionView) =>
	item.capabilities.filter((row) => row.state === 'granted').map((row) => row.label);

async function validate(id: string): Promise<void> {
	checking.value = id;
	checkError.value = null;
	try {
		await planes.validate(props.orgId, id);
	} catch (cause) {
		checkError.value = toApiClientError(cause).message;
	} finally {
		checking.value = null;
	}
}

function load(force = false): void {
	void planes.loadConnections(props.orgId, force);
}

onMounted(() => load());
watch(
	() => props.orgId,
	() => load()
);
</script>

<template>
	<section
		class="flex flex-col gap-4"
		aria-labelledby="plane-connections-title"
	>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<h2
				id="plane-connections-title"
				class="text-lg font-semibold text-highlighted"
			>
				Cloudflare Accounts
			</h2>
			<UButton
				to="/new/self-managed"
				color="neutral"
				variant="outline"
				icon="i-lucide-plus"
				>Connect an Account</UButton
			>
		</div>

		<UiErrorState
			v-if="planes.listError && items === undefined"
			title="Could Not Load Accounts"
			:text="planes.listError.message"
			:request-id="planes.listError.requestId"
		>
			<UButton
				color="neutral"
				@click="load(true)"
				>Try Again</UButton
			>
		</UiErrorState>

		<USkeleton
			v-else-if="items === undefined"
			class="h-24 w-full"
		/>

		<UiEmptyState
			v-else-if="items.length === 0"
			icon="i-lucide-cloud"
			title="No Accounts Connected"
			text="Connect your own Cloudflare account to run sites in it."
		/>

		<ul
			v-else
			class="flex flex-col gap-3"
		>
			<li
				v-for="item in items"
				:key="item.id"
				class="flex flex-col gap-3 rounded-lg border border-default p-4"
			>
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div class="flex min-w-0 flex-col gap-1">
						<h3 class="wrap-break-word font-medium text-highlighted">
							{{ item.accountName }}
						</h3>
						<p class="font-mono text-xs text-muted">{{ item.accountId }}</p>
					</div>
					<UBadge
						:color="STATE[item.state].color"
						variant="subtle"
						>{{ STATE[item.state].label }}</UBadge
					>
				</div>
				<dl class="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
					<div class="flex gap-2">
						<dt class="text-muted">Last Checked</dt>
						<dd class="text-default">{{ when(item.lastValidatedAt) }}</dd>
					</div>
					<div class="flex gap-2">
						<dt class="text-muted">Token</dt>
						<dd class="text-default">
							{{
								item.narrowerToken
									? 'Narrower token made by Drupflare'
									: item.tokenKind === 'account'
										? 'Account token you gave'
										: 'User token you gave'
							}}
						</dd>
					</div>
					<div
						v-if="item.workersSubdomain"
						class="flex gap-2"
					>
						<dt class="text-muted">Address</dt>
						<dd class="text-default">.{{ item.workersSubdomain }}.workers.dev</dd>
					</div>
					<div
						v-if="item.expiresOn"
						class="flex gap-2"
					>
						<dt class="text-muted">Expires</dt>
						<dd class="text-default">{{ item.expiresOn }}</dd>
					</div>
					<div
						v-if="item.revokedAt"
						class="flex gap-2"
					>
						<dt class="text-muted">Revoked</dt>
						<dd class="text-default">{{ when(item.revokedAt) }}</dd>
					</div>
				</dl>
				<p
					v-if="granted(item).length > 0 && item.state !== 'revoked'"
					class="text-sm text-muted"
				>
					Can use: {{ granted(item).join(', ') }}
				</p>
				<p
					v-if="item.state === 'invalid'"
					class="text-sm text-default"
				>
					The stored token no longer works. Connect the account again with a new token and
					its sites keep working.
				</p>
				<div
					v-if="item.state !== 'revoked'"
					class="flex flex-wrap gap-2"
				>
					<UButton
						color="neutral"
						variant="outline"
						icon="i-lucide-refresh-cw"
						:loading="checking === item.id"
						@click="validate(item.id)"
						>Check Again</UButton
					>
					<PlaneRevoke
						:org-id="orgId"
						:connection="item"
					/>
				</div>
			</li>
		</ul>
		<p
			v-if="checkError"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ checkError }}
		</p>
	</section>
</template>
