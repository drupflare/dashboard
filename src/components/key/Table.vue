<script setup lang="ts">
import { keyStateOf, type KeyState, type KeyView } from '~/shared/api-keys';

defineProps<{ orgId: string; keys: KeyView[]; canRevoke: boolean }>();

const when = (at: string | null, empty: string) =>
	at === null
		? empty
		: new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const STATE: Record<KeyState, { label: string; color: 'success' | 'neutral' | 'warning' }> = {
	active: { label: 'Active', color: 'success' },
	expired: { label: 'Expired', color: 'warning' },
	revoked: { label: 'Revoked', color: 'neutral' }
};
</script>

<template>
	<div class="overflow-x-auto rounded-lg border border-default">
		<table class="w-full text-left text-sm">
			<thead class="bg-elevated text-muted">
				<tr>
					<th
						scope="col"
						class="px-3 py-2 font-medium"
					>
						Name
					</th>
					<th
						scope="col"
						class="px-3 py-2 font-medium"
					>
						Key
					</th>
					<th
						scope="col"
						class="px-3 py-2 font-medium"
					>
						Permissions
					</th>
					<th
						scope="col"
						class="px-3 py-2 font-medium"
					>
						Last Used
					</th>
					<th
						scope="col"
						class="px-3 py-2 font-medium"
					>
						Expires
					</th>
					<th
						scope="col"
						class="px-3 py-2 font-medium"
					>
						Status
					</th>
					<th
						scope="col"
						class="px-3 py-2 font-medium"
					>
						<span class="sr-only">Actions</span>
					</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-default">
				<tr
					v-for="item in keys"
					:key="item.id"
				>
					<th
						scope="row"
						class="px-3 py-2 font-medium wrap-break-word text-highlighted"
					>
						{{ item.name }}
						<span class="block text-xs font-normal text-muted"
							>Created {{ when(item.createdAt, '') }}</span
						>
					</th>
					<td class="px-3 py-2 font-mono text-default">
						{{ item.prefix ?? 'Unavailable' }}
					</td>
					<td class="px-3 py-2 text-default">{{ item.scopes.length }}</td>
					<td class="px-3 py-2 text-default">{{ when(item.lastUsedAt, 'Never') }}</td>
					<td class="px-3 py-2 text-default">{{ when(item.expiresAt, 'Never') }}</td>
					<td class="px-3 py-2">
						<UBadge
							:color="STATE[keyStateOf(item, Date.now())].color"
							variant="subtle"
							>{{ STATE[keyStateOf(item, Date.now())].label }}</UBadge
						>
					</td>
					<td class="px-3 py-2 text-right">
						<KeyRevoke
							v-if="canRevoke && keyStateOf(item, Date.now()) === 'active'"
							:org-id="orgId"
							:api-key="item"
						/>
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
