<script setup lang="ts">
import { docContentPath, docRoute, isHiddenDoc } from '~/shared/docs';

definePageMeta({
	layout: 'docs',
	key: (to) => to.path,
	middleware: ['docs-admin']
});

const route = useRoute();
const path = computed(() => {
	const slug = route.params.slug;
	return docContentPath(Array.isArray(slug) ? slug : slug ? [slug] : []);
});

const { data: doc } = await useAsyncData(`docs:${path.value}`, () =>
	queryCollection('docs').path(path.value).first()
);

if (isHiddenDoc(doc.value, import.meta.dev)) {
	throw createError({ statusCode: 404, statusMessage: 'Page Not Found', fatal: true });
}

const { data: around } = await useAsyncData(`docs-around:${path.value}`, () =>
	queryCollectionItemSurroundings('docs', path.value, { fields: ['title', 'draft'] })
);

const neighbour = (item: { path: string; title: string; draft?: boolean } | undefined) =>
	item && (import.meta.dev || !item.draft) ? item : null;
const previous = computed(() => neighbour(around.value?.[0]));
const next = computed(() => neighbour(around.value?.[1]));

const toc = computed(() =>
	(doc.value?.body.toc?.links ?? []).flatMap((link) => [link, ...(link.children ?? [])])
);

useSeoMeta({
	title: doc.value?.title,
	description: doc.value?.description
});
</script>

<template>
	<article
		v-if="doc"
		class="flex min-w-0 flex-col gap-8"
	>
		<p
			v-if="doc.draft"
			role="note"
			class="rounded-md border border-default px-4 py-3 text-sm"
		>
			Draft: this page is hidden from the navigation and from the published site. You see it
			because the app runs locally.
		</p>
		<header class="flex flex-col gap-3">
			<h1 class="text-3xl font-bold text-highlighted">{{ doc.title }}</h1>
			<p class="text-default">{{ doc.description }}</p>
		</header>
		<nav
			v-if="toc.length"
			aria-labelledby="docs-toc"
			class="flex flex-col gap-2 text-sm"
		>
			<h2
				id="docs-toc"
				class="font-semibold text-highlighted"
			>
				On This Page
			</h2>
			<ul class="flex flex-col gap-1">
				<li
					v-for="link in toc"
					:key="link.id"
				>
					<a
						:href="`#${link.id}`"
						class="text-default hover:text-highlighted"
					>
						{{ link.text }}
					</a>
				</li>
			</ul>
		</nav>
		<ContentRenderer
			:value="doc"
			class="prose max-w-none"
		/>
		<nav
			v-if="previous || next"
			aria-label="Previous and next pages"
			class="flex items-start justify-between gap-4 border-t border-default pt-6 text-sm"
		>
			<NuxtLink
				v-if="previous"
				:to="docRoute(previous.path)"
				rel="prev"
				class="flex flex-col gap-1"
			>
				<span class="text-muted">Previous Page</span>
				<span class="text-highlighted">{{ previous.title }}</span>
			</NuxtLink>
			<span v-else />
			<NuxtLink
				v-if="next"
				:to="docRoute(next.path)"
				rel="next"
				class="flex flex-col items-end gap-1 text-right"
			>
				<span class="text-muted">Next Page</span>
				<span class="text-highlighted">{{ next.title }}</span>
			</NuxtLink>
		</nav>
	</article>
</template>
