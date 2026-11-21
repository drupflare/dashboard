<script setup lang="ts">
import { DOC_MIRRORS } from '~/shared/doc-mirrors';
import { docRoute, filterDocNav, flattenDocNav, isDocsAudience } from '~/shared/docs';

useSpool();

const route = useRoute();
const audience = computed(() => {
	const value = route.query.audience;
	return typeof value === 'string' && isDocsAudience(value) ? value : null;
});

const { data: navigation } = await useAsyncData('docs-navigation', () =>
	queryCollectionNavigation('docs', ['draft', 'audience'])
);

const rows = computed(() =>
	flattenDocNav(
		filterDocNav(navigation.value ?? [], {
			audience: audience.value,
			includeDrafts: import.meta.dev
		})
	)
);
</script>

<template>
	<NuxtLayout name="public">
		<div
			class="mx-auto grid w-full max-w-6xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[16rem_minmax(0,1fr)]"
		>
			<nav
				aria-label="Documentation"
				class="lg:sticky lg:top-6 lg:self-start"
			>
				<ul class="flex flex-col gap-1 text-sm">
					<li
						v-for="row in rows"
						:key="row.path"
						:style="{ paddingLeft: `${row.depth * 0.75}rem` }"
					>
						<span
							v-if="row.group"
							class="block pt-3 font-semibold text-highlighted"
						>
							{{ row.title }}
						</span>
						<NuxtLink
							v-else
							:to="docRoute(row.path)"
							class="block rounded-md px-2 py-1 text-default hover:text-highlighted"
							:aria-current="route.path === docRoute(row.path) ? 'page' : undefined"
						>
							{{ row.title }}
						</NuxtLink>
					</li>
				</ul>
				<p class="pt-6 text-sm font-semibold text-highlighted">Technical Documents</p>
				<ul class="flex flex-col gap-1 text-sm">
					<li
						v-for="mirror in DOC_MIRRORS"
						:key="mirror.id"
					>
						<NuxtLink
							:to="mirror.routePrefix"
							class="block rounded-md px-2 py-1 text-default hover:text-highlighted"
						>
							{{ mirror.title }}
						</NuxtLink>
					</li>
				</ul>
			</nav>
			<div class="min-w-0">
				<slot />
			</div>
		</div>
	</NuxtLayout>
</template>
