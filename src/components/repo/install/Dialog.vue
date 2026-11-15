<script setup lang="ts">
import type { CorpusResult } from '~/shared/corpus';
import { INSTALL_MODES } from '~/shared/install-modes';

defineProps<{ entry: CorpusResult | null }>();
const open = defineModel<boolean>('open', { default: false });
</script>

<template>
	<UModal
		v-model:open="open"
		title="Install Options"
		:description="entry?.name"
	>
		<template #body>
			<div class="flex flex-col gap-6">
				<section
					v-if="entry"
					class="flex flex-col gap-2"
				>
					<h3 class="font-medium text-highlighted">Codebase Check</h3>
					<p
						v-if="entry.install.allowed"
						class="flex items-center gap-2 text-sm text-default"
					>
						<UIcon
							name="i-lucide-check"
							class="size-4 text-success"
							aria-hidden="true"
						/>
						Allowed. {{ entry.name }} is verified and can be installed.
					</p>
					<p
						v-else
						class="flex items-center gap-2 text-sm text-default"
					>
						<UIcon
							name="i-lucide-ban"
							class="size-4 text-error"
							aria-hidden="true"
						/>
						Refused. {{ entry.install.reason }}
					</p>
				</section>

				<section class="flex flex-col gap-3">
					<h3 class="font-medium text-highlighted">Install Modes</h3>
					<ul class="flex flex-col gap-4">
						<li
							v-for="mode in INSTALL_MODES"
							:key="mode.id"
							class="flex flex-col gap-1"
						>
							<div class="flex flex-wrap items-center gap-2">
								<span class="font-medium text-highlighted">{{ mode.label }}</span>
								<UBadge
									v-if="mode.availability.state === 'available'"
									icon="i-lucide-check"
									color="success"
									variant="subtle"
								>
									Available
								</UBadge>
								<UBadge
									v-else
									icon="i-lucide-clock"
									color="neutral"
									variant="subtle"
								>
									Not Available Yet
								</UBadge>
							</div>
							<p class="text-sm text-muted">{{ mode.summary }}</p>
							<p
								v-if="mode.availability.state === 'unavailable'"
								class="text-sm text-default"
							>
								{{ mode.availability.reason }}
							</p>
						</li>
					</ul>
				</section>
			</div>
		</template>
	</UModal>
</template>
