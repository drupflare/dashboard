<script setup lang="ts">
const session = useSessionStore();
const route = useRoute();

const ACTIVE = 'border-brand-600 bg-elevated !text-highlighted dark:border-brand-400';

// the access login needs a full page load, so /admin is never a client route
const items = computed(() => [
	{ to: '/sites', label: 'Sites', icon: 'i-lucide-globe', external: false },
	{ to: '/planes', label: 'Planes', icon: 'i-lucide-server', external: false },
	{ to: '/org/billing', label: 'Billing', icon: 'i-lucide-credit-card', external: false },
	{ to: '/account', label: 'Account', icon: 'i-lucide-user-round', external: false },
	...(session.me?.platformRole === 'admin'
		? [{ to: '/admin', label: 'Admin', icon: 'i-lucide-shield', external: true }]
		: [])
]);
</script>

<template>
	<nav
		aria-label="Main"
		class="flex gap-1 overflow-x-auto md:w-48 md:flex-col md:overflow-visible"
	>
		<NuxtLink
			v-for="item in items"
			:key="item.to"
			:to="item.to"
			:external="item.external"
			class="inline-flex items-center gap-2 rounded-md border-l-2 border-transparent px-3 py-2 text-sm font-medium text-muted hover:bg-elevated hover:text-highlighted"
			:class="item.external && route.path === item.to ? ACTIVE : ''"
			:active-class="ACTIVE"
		>
			<UIcon
				:name="item.icon"
				class="size-4"
				aria-hidden="true"
			/>
			{{ item.label }}
		</NuxtLink>
	</nav>
</template>
