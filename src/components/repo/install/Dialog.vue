<script setup lang="ts">
import { usesOf } from '~/shared/code-sources';
import { checksSentence, type CorpusResult } from '~/shared/corpus';

const props = defineProps<{ entry: CorpusResult | null; rows: string[] }>();
const open = defineModel<boolean>('open', { default: false });

const uses = computed(() => (props.entry ? usesOf(props.entry) : []));
const verified = computed(
	() => props.entry?.status === 'verified' || props.entry?.status === 'deployed'
);
</script>

<template>
	<UModal
		v-model:open="open"
		:title="entry?.title ?? 'Details'"
		:description="entry?.summary || undefined"
	>
		<template #body>
			<div
				v-if="entry"
				class="flex flex-col gap-6"
			>
				<section class="flex flex-col gap-2">
					<h3 class="font-medium text-highlighted">What We Checked</h3>
					<p class="text-sm text-default">
						{{ checksSentence(entry) }}.
						<template v-if="entry.legacy">
							This codebase needs an older Drupal than the platform runs, so the
							result comes from a run with the legacy layer on
							{{ entry.legacy.date }}.
							<template v-if="entry.legacy.baseOnly"
								>That run covered the base site only, without its modules.</template
							>
						</template>
					</p>
					<ul
						v-if="entry.blockers.length"
						class="flex flex-col gap-2 text-sm"
					>
						<li
							v-for="blocker in entry.blockers"
							:key="blocker.reason"
							class="flex flex-col"
						>
							<span class="text-default">{{ blocker.reason }}</span>
							<span class="text-muted">{{ blocker.checks.join(', ') }}</span>
						</li>
					</ul>
					<details class="text-sm">
						<summary class="cursor-pointer text-muted">All checks</summary>
						<RepoCorpusCells
							class="mt-2"
							:rows="rows"
							:cells="entry.cells"
						/>
					</details>
					<p
						v-if="!verified"
						class="text-sm text-muted"
					>
						Not verified does not mean blocked. You can still add this code. Expect the
						failures above.
					</p>
				</section>

				<section class="flex flex-col gap-3">
					<h3 class="font-medium text-highlighted">Ways to Use It</h3>
					<ul class="flex flex-col gap-4">
						<li
							v-for="use in uses"
							:key="use.label"
							class="flex flex-col gap-1"
						>
							<div class="flex flex-wrap items-center justify-between gap-2">
								<span class="font-medium text-highlighted">{{ use.label }}</span>
								<UButton
									v-if="use.href"
									:to="use.href"
									color="neutral"
									variant="outline"
									>Open</UButton
								>
							</div>
							<p class="text-sm text-muted">{{ use.summary }}</p>
							<p
								v-if="use.reason"
								class="text-sm text-default"
							>
								{{ use.reason }}
							</p>
						</li>
					</ul>
					<UButton
						v-if="entry.repo"
						:to="entry.repo"
						target="_blank"
						rel="noopener"
						color="neutral"
						variant="link"
						icon="i-lucide-external-link"
						class="self-start"
						>View the Repository</UButton
					>
				</section>
			</div>
		</template>
	</UModal>
</template>
