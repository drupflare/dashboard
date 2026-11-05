export const API_TAGS = [
	{ name: 'auth', description: 'Sign-in, sign-out and passkey and provider flows.' },
	{ name: 'me', description: 'The signed-in account, its sessions and devices.' },
	{ name: 'orgs', description: 'Organisations and departments.' },
	{ name: 'members', description: 'Organisation members and their roles.' },
	{ name: 'invites', description: 'Invitations to join an organisation.' },
	{ name: 'delegations', description: 'Agency access to a client organisation.' },
	{ name: 'api-keys', description: 'API keys for scripts and integrations.' },
	{ name: 'sites', description: 'Sites and everything that belongs to one.' },
	{ name: 'operations', description: 'Long-running operations and their steps.' },
	{ name: 'planes', description: 'Planes a site can run on.' },
	{ name: 'nodes', description: 'Bastion nodes and fleet links.' },
	{ name: 'imports', description: 'Imports from existing hosting.' },
	{ name: 'cutovers', description: 'Migration cutovers.' },
	{ name: 'assessments', description: 'Estate assessments.' },
	{ name: 'repos', description: 'Repository connections.' },
	{ name: 'modules', description: 'Modules and the module census.' },
	{ name: 'releases', description: 'Releases and upgrades.' },
	{ name: 'rings', description: 'Release rings and cohorts.' },
	{ name: 'billing', description: 'Plans, invoices and the billing portal.' },
	{ name: 'usage', description: 'Usage reports and accounting.' },
	{ name: 'notifications', description: 'Notification settings and the inbox.' },
	{ name: 'audit', description: 'The organisation audit log.' },
	{ name: 'templates', description: 'Site templates.' },
	{ name: 'clients', description: 'Client organisations managed by an agency.' },
	{ name: 'transfers', description: 'Site transfers between organisations.' },
	{ name: 'pilots', description: 'Pilot workspaces.' },
	{ name: 'cost-centers', description: 'Cost centers.' },
	{ name: 'procurement', description: 'Procurement records.' },
	{ name: 'trust', description: 'Trust center content.' },
	{ name: 'demo', description: 'The read-only demo dashboard.' },
	{ name: 'gate', description: 'Visitor access to private sites and environments.' },
	{ name: 'admin', description: 'Platform administration.' },
	{ name: 'system', description: 'Liveness and API documentation.' }
] as const;

export type ApiTag = (typeof API_TAGS)[number]['name'];

export const API_TAG_NAMES: readonly string[] = API_TAGS.map((tag) => tag.name);

export function isApiTag(value: unknown): value is ApiTag {
	return typeof value === 'string' && API_TAG_NAMES.includes(value);
}
