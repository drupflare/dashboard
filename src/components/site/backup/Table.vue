<script setup lang="ts">
import type { BackupView } from '~/stores/backups';

const props = defineProps<{ backups: BackupView[]; downloading: string | null }>();
const emit = defineEmits<{ restore: [backup: BackupView]; download: [backup: BackupView] }>();

const rows = computed(() =>
	[...props.backups].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
);

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

function when(value: string): string {
	return dateFormat.format(new Date(value));
}

function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
</script>

<template>
	<div class="overflow-x-auto rounded-lg border border-default">
		<table class="w-full text-left text-sm">
			<caption class="sr-only">
				Backups of This Site, Newest First
			</caption>
			<thead class="bg-elevated text-muted">
				<tr>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Created
					</th>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Size
					</th>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Verified
					</th>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Actions
					</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="backup in rows"
					:key="backup.id"
					class="border-t border-default"
				>
					<td class="px-4 py-3">
						<time :datetime="backup.createdAt">{{ when(backup.createdAt) }}</time>
					</td>
					<td class="px-4 py-3">{{ size(backup.bytes) }}</td>
					<td class="px-4 py-3">
						<span
							v-if="backup.verified"
							class="inline-flex items-center gap-1.5 text-leaf-700 dark:text-leaf-300"
						>
							<UIcon
								name="i-lucide-circle-check"
								class="size-4 shrink-0"
								aria-hidden="true"
							/>
							<span>Verified</span>
						</span>
						<span
							v-else
							class="inline-flex items-center gap-1.5 text-muted"
						>
							<UIcon
								name="i-lucide-clock"
								class="size-4 shrink-0"
								aria-hidden="true"
							/>
							<span>Not Verified Yet</span>
						</span>
					</td>
					<td class="px-4 py-3">
						<div class="flex flex-wrap items-center gap-2">
							<UButton
								color="neutral"
								variant="outline"
								size="sm"
								icon="i-lucide-undo-2"
								:disabled="!backup.restorable"
								:aria-label="`Restore backup from ${when(backup.createdAt)}`"
								@click="emit('restore', backup)"
							>
								Restore
							</UButton>
							<UButton
								color="neutral"
								variant="outline"
								size="sm"
								icon="i-lucide-download"
								:loading="downloading === backup.id"
								:disabled="downloading !== null"
								:aria-label="`Download backup from ${when(backup.createdAt)}`"
								@click="emit('download', backup)"
							>
								Download
							</UButton>
						</div>
						<p
							v-if="!backup.restorable"
							class="mt-1 text-xs text-muted"
						>
							{{ backup.notRestorableReason }}
						</p>
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
