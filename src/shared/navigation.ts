import {
	actionDef,
	ORG_ROLE_ACTIONS,
	PLATFORM_ROLE_PERMISSIONS,
	type Action,
	type OrgRole,
	type PlatformRole
} from './permissions';

export interface NavItem {
	to: string;
	label: string;
	icon: string;
	// the page's read action; the item shows to each role that holds it
	action: Action;
}

export interface NavGroup {
	id: 'people' | 'sites' | 'billing' | 'compliance';
	label: string;
	items: readonly NavItem[];
}

export const ORG_NAV_GROUPS: readonly NavGroup[] = [
	{
		id: 'people',
		label: 'People',
		items: [
			{ to: '/org/members', label: 'Members', icon: 'i-lucide-users', action: 'member.read' },
			{
				to: '/org/departments',
				label: 'Departments',
				icon: 'i-lucide-network',
				action: 'department.read'
			},
			{
				to: '/org/service-accounts',
				label: 'Service Accounts',
				icon: 'i-lucide-bot',
				action: 'service-account.manage'
			},
			{
				to: '/org/reviews',
				label: 'Access Reviews',
				icon: 'i-lucide-clipboard-check',
				action: 'review.read'
			},
			{
				to: '/org/delegations',
				label: 'Agency Access',
				icon: 'i-lucide-handshake',
				action: 'delegation.read'
			},
			{
				to: '/org/api-keys',
				label: 'API Keys',
				icon: 'i-lucide-key-round',
				action: 'key.read'
			}
		]
	},
	{
		id: 'sites',
		label: 'Sites',
		items: [
			{
				to: '/org/transfers',
				label: 'Site Transfers',
				icon: 'i-lucide-arrow-right-left',
				action: 'transfer.read'
			},
			{
				to: '/org/clients',
				label: 'Clients',
				icon: 'i-lucide-briefcase',
				action: 'client.read'
			},
			{
				to: '/org/pilots',
				label: 'Pilots',
				icon: 'i-lucide-flask-conical',
				action: 'pilot.read'
			}
		]
	},
	{
		id: 'billing',
		label: 'Billing',
		items: [
			{
				to: '/org/billing',
				label: 'Plan and Invoices',
				icon: 'i-lucide-credit-card',
				action: 'billing.read'
			},
			{
				to: '/org/budget',
				label: 'Spend Budget',
				icon: 'i-lucide-piggy-bank',
				action: 'billing.manage'
			},
			{ to: '/org/usage', label: 'Usage', icon: 'i-lucide-activity', action: 'usage.read' },
			{
				to: '/org/cost-centers',
				label: 'Cost Centers',
				icon: 'i-lucide-chart-pie',
				action: 'cost-center.read'
			},
			{
				to: '/org/procurement',
				label: 'Procurement',
				icon: 'i-lucide-shopping-cart',
				action: 'procurement.read'
			}
		]
	},
	{
		id: 'compliance',
		label: 'Compliance',
		items: [
			{
				to: '/org/policies',
				label: 'Policies',
				icon: 'i-lucide-scale',
				action: 'policy.read'
			},
			{
				to: '/org/sso',
				label: 'Organization Sign-In',
				icon: 'i-lucide-log-in',
				action: 'org.sso.manage'
			},
			{
				to: '/org/contacts',
				label: 'Contacts',
				icon: 'i-lucide-contact',
				action: 'contact.read'
			},
			{
				to: '/org/support',
				label: 'Support Access',
				icon: 'i-lucide-life-buoy',
				action: 'support-grant.read'
			}
		]
	}
];

// the top of the side nav; every item here is an organization page or a page of its own
export const WORKSPACE_NAV: readonly NavItem[] = [
	{ to: '/repos', label: 'Repositories', icon: 'i-lucide-git-branch', action: 'repo.read' },
	{ to: '/planes', label: 'Planes', icon: 'i-lucide-server', action: 'plane.read' },
	{
		to: '/org/integrations',
		label: 'Integrations',
		icon: 'i-lucide-git-branch',
		action: 'integration.read'
	}
];

export const ADMIN_CONSOLES: readonly NavItem[] = [
	{ to: '/admin/users', label: 'Users', icon: 'i-lucide-users', action: 'admin.metadata.read' },
	{
		to: '/admin/orgs',
		label: 'Organizations',
		icon: 'i-lucide-building-2',
		action: 'admin.metadata.read'
	},
	{ to: '/admin/sites', label: 'Sites', icon: 'i-lucide-globe', action: 'admin.metadata.read' },
	{
		to: '/admin/operations',
		label: 'Operations',
		icon: 'i-lucide-list-checks',
		action: 'admin.metadata.read'
	},
	{ to: '/admin/mail', label: 'Mail', icon: 'i-lucide-mail', action: 'admin.metadata.read' },
	{
		to: '/admin/abuse',
		label: 'Abuse Queue',
		icon: 'i-lucide-shield-alert',
		action: 'admin.abuse.read'
	},
	{
		to: '/admin/flags',
		label: 'Platform Switches',
		icon: 'i-lucide-toggle-right',
		action: 'admin.flags.read'
	},
	{
		to: '/admin/trust',
		label: 'Trust Documents',
		icon: 'i-lucide-file-badge',
		action: 'admin.trust.read'
	},
	{
		to: '/admin/support-grants',
		label: 'Support Access',
		icon: 'i-lucide-life-buoy',
		action: 'admin.support-grants.read'
	},
	{
		to: '/admin/db',
		label: 'Database Console',
		icon: 'i-lucide-database',
		action: 'admin.db.read'
	},
	{
		to: '/admin/capacity',
		label: 'Capacity',
		icon: 'i-lucide-gauge',
		action: 'admin.capacity.read'
	},
	{
		to: '/admin/releases',
		label: 'Releases',
		icon: 'i-lucide-rocket',
		action: 'admin.aggregates.read'
	},
	{
		to: '/admin/ladder',
		label: 'Repair Ladder',
		icon: 'i-lucide-list-ordered',
		action: 'admin.ladder.read'
	}
];

export function orgRoleHolds(role: OrgRole | null, action: Action): boolean {
	return role !== null && ORG_ROLE_ACTIONS[role].includes(action);
}

export function platformRoleHolds(role: PlatformRole, action: Action): boolean {
	const platform = actionDef(action).platform;
	return platform !== undefined && PLATFORM_ROLE_PERMISSIONS[role].includes(platform);
}
