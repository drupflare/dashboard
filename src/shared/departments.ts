import { z } from 'zod';

export const DEPARTMENT_KINDS = ['division', 'department'] as const;
export type DepartmentKind = (typeof DEPARTMENT_KINDS)[number];

export const DEPARTMENT_ROLES = ['admin', 'developer', 'billing', 'viewer'] as const;
export type DepartmentRole = (typeof DEPARTMENT_ROLES)[number];

export const MAX_DEPARTMENT_DEPTH = 4;
export const MAX_SITE_QUOTA = 100_000;

export const DEPARTMENT_KIND_LABEL: Record<DepartmentKind, string> = {
	division: 'Division',
	department: 'Department'
};

export const DEPARTMENT_ROLE_LABEL: Record<DepartmentRole, string> = {
	admin: 'Admin',
	developer: 'Developer',
	billing: 'Billing',
	viewer: 'Viewer'
};

const nameSchema = z.string().trim().min(1).max(80);

export const departmentViewSchema = z.strictObject({
	id: z.string(),
	parentId: z.string().nullable(),
	name: z.string(),
	kind: z.enum(DEPARTMENT_KINDS),
	siteQuota: z.number().int().nullable(),
	ownSites: z.number().int(),
	subtreeSites: z.number().int(),
	childCount: z.number().int(),
	memberCount: z.number().int(),
	// whether the signed-in person can manage members and sites in this department
	canManage: z.boolean(),
	createdAt: z.string()
});
export type DepartmentView = z.infer<typeof departmentViewSchema>;

// central is true for an organization owner or admin, who alone set limits and shape the tree
export const departmentListSchema = z.strictObject({
	items: z.array(departmentViewSchema),
	central: z.boolean()
});
export type DepartmentList = z.infer<typeof departmentListSchema>;

export const departmentCreateBodySchema = z.strictObject({
	name: nameSchema,
	kind: z.enum(DEPARTMENT_KINDS),
	parentId: z.string().min(1).max(64).nullable().optional()
});
export type DepartmentCreateBody = z.infer<typeof departmentCreateBodySchema>;

export const departmentUpdateBodySchema = z
	.strictObject({
		name: nameSchema.optional(),
		parentId: z.string().min(1).max(64).nullable().optional()
	})
	.refine((body) => body.name !== undefined || body.parentId !== undefined, {
		message: 'Send a name or a parent'
	});
export type DepartmentUpdateBody = z.infer<typeof departmentUpdateBodySchema>;

export const quotaBodySchema = z.strictObject({
	siteQuota: z.number().int().min(0).max(MAX_SITE_QUOTA).nullable()
});
export type QuotaBody = z.infer<typeof quotaBodySchema>;

export const departmentMemberViewSchema = z.strictObject({
	userId: z.string(),
	email: z.string(),
	displayName: z.string().nullable(),
	role: z.enum(DEPARTMENT_ROLES),
	grantedAt: z.string()
});
export type DepartmentMemberView = z.infer<typeof departmentMemberViewSchema>;

export const departmentMemberListSchema = z.strictObject({
	items: z.array(departmentMemberViewSchema)
});
export type DepartmentMemberList = z.infer<typeof departmentMemberListSchema>;

export const departmentMemberBodySchema = z.strictObject({
	email: z.string().trim().toLowerCase().email().max(254),
	role: z.enum(DEPARTMENT_ROLES)
});
export type DepartmentMemberBody = z.infer<typeof departmentMemberBodySchema>;

export const departmentRoleBodySchema = z.strictObject({ role: z.enum(DEPARTMENT_ROLES) });
export type DepartmentRoleBody = z.infer<typeof departmentRoleBodySchema>;

export const placementSiteSchema = z.strictObject({
	id: z.string(),
	name: z.string(),
	departmentId: z.string().nullable()
});
export type PlacementSite = z.infer<typeof placementSiteSchema>;

export const placementListSchema = z.strictObject({ items: z.array(placementSiteSchema) });
export type PlacementList = z.infer<typeof placementListSchema>;

// null puts the site back at the organization level
export const siteDepartmentBodySchema = z.strictObject({
	departmentId: z.string().min(1).max(64).nullable()
});
export type SiteDepartmentBody = z.infer<typeof siteDepartmentBodySchema>;

export const siteDepartmentViewSchema = z.strictObject({
	siteId: z.string(),
	departmentId: z.string().nullable()
});
export type SiteDepartmentView = z.infer<typeof siteDepartmentViewSchema>;

export interface TreeNode {
	department: DepartmentView;
	children: TreeNode[];
}

// roots first, each level in name order; a node whose parent is missing is shown as a root
export function buildTree(items: readonly DepartmentView[]): TreeNode[] {
	const nodes = new Map<string, TreeNode>(
		items.map((d) => [d.id, { department: d, children: [] }])
	);
	const roots: TreeNode[] = [];
	for (const node of nodes.values()) {
		const parent =
			node.department.parentId === null ? undefined : nodes.get(node.department.parentId);
		(parent ? parent.children : roots).push(node);
	}
	const sort = (list: TreeNode[]) => {
		list.sort((a, b) => a.department.name.localeCompare(b.department.name));
		for (const node of list) sort(node.children);
	};
	sort(roots);
	return roots;
}

// the quota line a person reads: "3 of 10 sites" or "3 sites, no limit"
export function quotaText(view: Pick<DepartmentView, 'siteQuota' | 'subtreeSites'>): string {
	const used = view.subtreeSites;
	const noun = (n: number) => (n === 1 ? 'Site' : 'Sites');
	if (view.siteQuota === null) return `${used} ${noun(used)}, No Limit`;
	return `${used} of ${view.siteQuota} ${noun(view.siteQuota)}`;
}
