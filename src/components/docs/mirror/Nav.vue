<script setup lang="ts">
import { mirrorRoute, safeHref, type DocMirror, type MirrorNavItem } from '~/shared/doc-mirrors';

defineProps<{
	items: MirrorNavItem[];
	mirror: Pick<DocMirror, 'routePrefix'>;
	current: string;
}>();

const routeOf = (mirror: Pick<DocMirror, 'routePrefix'>, item: MirrorNavItem) =>
	item.slug ? mirrorRoute(mirror, item.slug.join('/')) : null;
</script>

<template>
	<ul class="flex flex-col gap-1 text-sm">
		<li
			v-for="item in items"
			:key="item.title + (item.slug ? item.slug.join('/') : (item.url ?? ''))"
		>
			<NuxtLink
				v-if="routeOf(mirror, item)"
				:to="routeOf(mirror, item)!"
				class="block rounded-md px-2 py-1 text-default hover:text-highlighted"
				:aria-current="current === routeOf(mirror, item) ? 'page' : undefined"
			>
				{{ item.title }}
			</NuxtLink>
			<a
				v-else-if="item.url && safeHref(item.url)"
				:href="safeHref(item.url)!"
				rel="noopener noreferrer"
				class="block rounded-md px-2 py-1 text-default hover:text-highlighted"
			>
				{{ item.title }}
			</a>
			<span
				v-else
				class="block pt-3 font-semibold text-highlighted"
			>
				{{ item.title }}
			</span>
			<div
				v-if="item.children?.length"
				class="pl-3"
			>
				<DocsMirrorNav
					:items="item.children"
					:mirror="mirror"
					:current="current"
				/>
			</div>
		</li>
	</ul>
</template>
