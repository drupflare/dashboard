<script setup lang="ts">
import type { ClientView } from '~/shared/agency';

const props = defineProps<{ client: ClientView; canManage: boolean; canGroup: boolean }>();
const emit = defineEmits<{ edit: []; delete: []; removeSite: [siteId: string] }>();
</script>

<template>
	<article
		class="flex flex-col gap-4 rounded-lg border border-default bg-default p-4"
		:aria-labelledby="`client-${client.id}`"
	>
		<header class="flex flex-wrap items-start justify-between gap-3">
			<h3
				:id="`client-${client.id}`"
				class="text-lg font-semibold text-highlighted"
			>
				{{ client.name }}
			</h3>
			<div
				v-if="canManage"
				class="flex gap-2"
			>
				<UButton
					color="neutral"
					variant="outline"
					@click="emit('edit')"
					>Edit Client</UButton
				>
				<UButton
					color="error"
					variant="ghost"
					@click="emit('delete')"
					>Delete Client</UButton
				>
			</div>
		</header>

		<dl class="grid gap-3 text-sm sm:grid-cols-2">
			<div>
				<dt class="font-medium text-muted">Contact Name</dt>
				<dd class="text-default">{{ client.contactName ?? 'Not set' }}</dd>
			</div>
			<div>
				<dt class="font-medium text-muted">Contact Email</dt>
				<dd class="text-default">{{ client.contactEmail ?? 'Not set' }}</dd>
			</div>
			<div class="sm:col-span-2">
				<dt class="font-medium text-muted">Who the End Customer Contacts</dt>
				<dd class="whitespace-pre-line text-default">{{ client.notes ?? 'Not set' }}</dd>
			</div>
			<div class="sm:col-span-2">
				<dt class="font-medium text-muted">Contract Notes</dt>
				<dd class="whitespace-pre-line text-default">
					{{ client.contractNotes ?? 'Not set' }}
				</dd>
			</div>
		</dl>

		<section class="flex flex-col gap-2">
			<h4 class="text-sm font-semibold text-highlighted">Sites</h4>
			<p
				v-if="client.siteIds.length === 0"
				class="text-sm text-muted"
			>
				No sites under this client yet.
			</p>
			<ul
				v-else
				class="flex flex-col gap-2"
			>
				<li
					v-for="siteId in client.siteIds"
					:key="siteId"
					class="flex items-center justify-between gap-3 text-sm"
				>
					<code class="break-all text-default">{{ siteId }}</code>
					<UButton
						v-if="canGroup"
						color="neutral"
						variant="link"
						:aria-label="`Remove ${siteId} from ${client.name}`"
						@click="emit('removeSite', siteId)"
						>Remove Site</UButton
					>
				</li>
			</ul>
		</section>
	</article>
</template>
