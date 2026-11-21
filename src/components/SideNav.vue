<script setup lang="ts">
import { ORG_NAV_GROUPS, orgRoleHolds, WORKSPACE_NAV } from '~/shared/navigation';
import { isOrgRole } from '~/shared/permissions';

const session = useSessionStore();
const org = useOrgStore();

const ACTIVE = 'border-brand-600 bg-elevated !text-highlighted dark:border-brand-400';
const LINK =
	'inline-flex items-center gap-2 rounded-md border-l-2 border-transparent px-3 py-2 text-sm font-medium text-muted hover:bg-elevated hover:text-highlighted';

// an org page shows to a role only when the catalogue gives that role its read action
const role = computed(() => (isOrgRole(org.current?.role) ? org.current.role : null));
const workspace = computed(() =>
	WORKSPACE_NAV.filter((item) => orgRoleHolds(role.value, item.action))
);
const groups = computed(() =>
	ORG_NAV_GROUPS.map((group) => ({
		...group,
		items: group.items.filter((item) => orgRoleHolds(role.value, item.action))
	})).filter((group) => group.items.length > 0)
);
</script>

<template>
	<nav
		aria-label="Main"
		class="flex gap-1 overflow-x-auto md:w-56 md:flex-col md:overflow-visible"
	>
		<NuxtLink
			to="/sites"
			:class="LINK"
			:active-class="ACTIVE"
			:external="false"
		>
			<UIcon
				name="i-lucide-globe"
				class="size-4"
				aria-hidden="true"
			/>
			Sites
		</NuxtLink>
		<ClientOnly>
			<NuxtLink
				v-for="item in workspace"
				:key="item.to"
				:to="item.to"
				:class="LINK"
				:active-class="ACTIVE"
				:external="false"
			>
				<UIcon
					:name="item.icon"
					class="size-4"
					aria-hidden="true"
				/>
				{{ item.label }}
			</NuxtLink>
			<template
				v-for="group in groups"
				:key="group.id"
			>
				<p class="hidden px-3 pt-4 text-xs font-medium text-muted md:block">
					{{ group.label }}
				</p>
				<NuxtLink
					v-for="item in group.items"
					:key="item.to"
					:to="item.to"
					:class="LINK"
					:active-class="ACTIVE"
					:external="false"
				>
					<UIcon
						:name="item.icon"
						class="size-4"
						aria-hidden="true"
					/>
					{{ item.label }}
				</NuxtLink>
			</template>
		</ClientOnly>
		<NuxtLink
			to="/account"
			:class="LINK"
			:active-class="ACTIVE"
			:external="false"
		>
			<UIcon
				name="i-lucide-user-round"
				class="size-4"
				aria-hidden="true"
			/>
			Account
		</NuxtLink>
		<ClientOnly>
			<NuxtLink
				v-if="session.me?.platformRole === 'admin'"
				to="/admin"
				external
				:class="LINK"
			>
				<UIcon
					name="i-lucide-shield"
					class="size-4"
					aria-hidden="true"
				/>
				Admin
			</NuxtLink>
		</ClientOnly>
	</nav>
</template>
