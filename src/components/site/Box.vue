<script setup lang="ts">
import {
	CHECK_BOX_LABEL,
	FOUND_NAME_NOTE,
	FOUND_NOTE,
	MISSING_NOTE,
	missingSinceNote
} from '~/shared/box-sites';
import type { SiteSummary } from '~/stores/sites';

const props = defineProps<{ site: SiteSummary }>();

const found = computed(() => props.site.box?.found === true);
const missingSince = computed(() => props.site.box?.missingSince ?? null);
const placeholder = computed(() => found.value && props.site.primaryHostname === null);
const emit = defineEmits<{ renamed: [site: SiteSummary] }>();
</script>

<template>
	<section
		v-if="found || missingSince !== null"
		class="flex flex-col gap-3 rounded-lg border border-default p-4"
		data-test="box-notice"
	>
		<p
			v-if="found"
			class="text-sm text-default"
			data-test="found-note"
		>
			{{ FOUND_NOTE }}
		</p>
		<p
			v-if="placeholder"
			class="text-sm text-default"
			data-test="name-note"
		>
			{{ FOUND_NAME_NOTE }}
		</p>
		<div
			v-if="missingSince !== null"
			class="flex flex-col gap-2"
			data-test="missing-note"
		>
			<p class="text-sm text-default">{{ MISSING_NOTE }}</p>
			<p class="text-sm text-muted">{{ missingSinceNote(missingSince) }}</p>
			<div>
				<UButton
					color="neutral"
					variant="outline"
					icon="i-lucide-server"
					to="/planes"
					>{{ CHECK_BOX_LABEL }}</UButton
				>
			</div>
		</div>
		<SiteRename
			v-if="found"
			:org-id="site.orgId"
			:site-id="site.id"
			:name="site.name"
			@renamed="emit('renamed', $event)"
		/>
	</section>
</template>
