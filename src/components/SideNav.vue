<script setup lang="ts">
const session = useSessionStore();

const items = computed(() => [
	{ to: '/sites', label: 'Sites', icon: 'i-lucide-globe' },
	{ to: '/account', label: 'Account', icon: 'i-lucide-user-round' },
	...(session.me?.platformRole === 'admin'
		? [{ to: '/admin', label: 'Admin', icon: 'i-lucide-shield' }]
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
			class="inline-flex items-center gap-2 rounded-md border-l-2 border-transparent px-3 py-2 text-sm font-medium text-muted hover:bg-elevated hover:text-highlighted"
			active-class="border-brand-600 bg-elevated !text-highlighted dark:border-brand-400"
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
