<script setup lang="ts">
import type { MirrorPageView } from '~/server/services/doc-mirror';
import { mirrorById, mirrorRoute, type DocMirror, type MirrorId } from '~/shared/doc-mirrors';

const props = defineProps<{ mirror: MirrorId }>();

const mirror = mirrorById(props.mirror);
if (!mirror) throw createError({ statusCode: 404, statusMessage: 'Page Not Found', fatal: true });

const route = useRoute();
const slug = computed(() => {
	const value = route.params.slug;
	return Array.isArray(value) ? value.join('/') : (value ?? '');
});

// the request-scoped fetch carries the Worker bindings into the server route during SSR
const requestFetch = useRequestFetch();

const { data: view } = await useAsyncData(`docs-mirror:${mirror.id}:${slug.value}`, () =>
	// a literal url type keeps nitro's typed route lookup narrow
	requestFetch<MirrorPageView, `${DocMirror['routePrefix']}/_page`>(
		`${mirror.routePrefix}/_page`,
		{
			query: { slug: slug.value }
		}
	)
);

if (!view.value) {
	throw createError({ statusCode: 404, statusMessage: 'Page Not Found', fatal: true });
}

const synced = computed(() => {
	const at = view.value?.syncedAt;
	return at ? `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : null;
});
const shortSha = computed(() => view.value?.sha.slice(0, 7) ?? '');
const syncNote = computed(() =>
	synced.value
		? `Last synced ${synced.value} from ${shortSha.value}.`
		: 'This page was read from GitHub before the first sync.'
);
const toc = computed(() => view.value?.page.toc ?? []);

useSeoMeta({
	title: view.value.page.title,
	description: `${mirror.title} documentation: ${view.value.page.title}`
});
useHead({ link: [{ rel: 'canonical', href: view.value.original }] });
</script>

<template>
	<div
		v-if="view"
		class="mx-auto grid w-full max-w-6xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[16rem_minmax(0,1fr)]"
	>
		<nav
			:aria-label="`${mirror.title} Documentation`"
			class="flex flex-col gap-3 lg:sticky lg:top-6 lg:self-start"
		>
			<NuxtLink
				to="/docs"
				class="text-sm text-muted hover:text-highlighted"
			>
				All Documentation
			</NuxtLink>
			<DocsMirrorNav
				:items="view.nav"
				:mirror="mirror"
				:current="route.path"
			/>
		</nav>
		<article class="flex min-w-0 flex-col gap-8">
			<p
				role="note"
				class="rounded-md border border-default px-4 py-3 text-sm"
			>
				This is a mirror of
				<a
					:href="mirror.home"
					rel="noopener noreferrer"
					class="underline"
					>{{ mirror.home }}</a
				>.
				{{ syncNote }}
				<a
					:href="view.original"
					rel="noopener noreferrer"
					class="underline"
					>Open the original</a
				>
			</p>
			<h1
				v-if="!view.page.hasH1"
				class="text-3xl font-bold text-highlighted"
			>
				{{ view.page.title }}
			</h1>
			<nav
				v-if="toc.length"
				aria-labelledby="docs-mirror-toc"
				class="flex flex-col gap-2 text-sm"
			>
				<h2
					id="docs-mirror-toc"
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
			<div class="prose max-w-none">
				<DocsMirrorBlock :nodes="view.page.nodes" />
			</div>
			<nav
				v-if="view.previous || view.next"
				aria-label="Previous and next pages"
				class="flex items-start justify-between gap-4 border-t border-default pt-6 text-sm"
			>
				<NuxtLink
					v-if="view.previous?.slug"
					:to="mirrorRoute(mirror, view.previous.slug.join('/'))"
					rel="prev"
					class="flex flex-col gap-1"
				>
					<span class="text-muted">Previous Page</span>
					<span class="text-highlighted">{{ view.previous.title }}</span>
				</NuxtLink>
				<span v-else />
				<NuxtLink
					v-if="view.next?.slug"
					:to="mirrorRoute(mirror, view.next.slug.join('/'))"
					rel="next"
					class="flex flex-col items-end gap-1 text-right"
				>
					<span class="text-muted">Next Page</span>
					<span class="text-highlighted">{{ view.next.title }}</span>
				</NuxtLink>
			</nav>
		</article>
	</div>
</template>
