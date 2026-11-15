import { z } from 'zod';

export const MODULE_STATES = ['verified', 'untested', 'blocked'] as const;
export type ModuleState = (typeof MODULE_STATES)[number];

export const MODULE_KINDS = ['module', 'theme', 'unknown'] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

export const CONFLICT_REASONS = ['missing', 'version', 'unverifiable', 'polyfilled'] as const;

const NAME = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

const moduleRowBase = z.object({
	name: z.string().regex(NAME),
	label: z.string().min(1),
	kind: z.enum(MODULE_KINDS),
	state: z.enum(MODULE_STATES),
	shipping: z.boolean(),
	reason: z.string().min(1).optional(),
	needs: z.array(z.string().min(1))
});

export const moduleRowSchema = moduleRowBase.superRefine((row, ctx) => {
	if (row.state === 'blocked' && row.reason === undefined) {
		ctx.addIssue({
			code: 'custom',
			path: ['reason'],
			message: 'a blocked row names its reason'
		});
	}
	if (row.shipping && row.state !== 'verified') {
		ctx.addIssue({
			code: 'custom',
			path: ['shipping'],
			message: 'a shipped module is verified'
		});
	}
});

export const moduleManifestSchema = z
	.object({ modules: z.array(moduleRowSchema).min(1) })
	.superRefine((manifest, ctx) => {
		const seen = new Set<string>();
		manifest.modules.forEach((row, index) => {
			if (seen.has(row.name)) {
				ctx.addIssue({
					code: 'custom',
					path: ['modules', index, 'name'],
					message: `${row.name} is listed twice`
				});
			}
			seen.add(row.name);
		});
	});

export type ModuleRow = z.infer<typeof moduleRowSchema>;
export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

export class ModuleManifestInvalidError extends Error {}

// the value form, so the sync script can validate an object it built and refuse before it writes
export function parseModuleManifestValue(value: unknown): ModuleManifest {
	const parsed = moduleManifestSchema.safeParse(value);
	if (!parsed.success) {
		throw new ModuleManifestInvalidError(
			parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')
		);
	}
	return parsed.data;
}

export function parseModuleManifest(text: string): ModuleManifest {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (err) {
		throw new ModuleManifestInvalidError(`manifest is not JSON: ${(err as Error).message}`);
	}
	return parseModuleManifestValue(json);
}

export interface ModuleQuery {
	q?: string;
	state?: ModuleState;
	kind?: ModuleKind;
}

export const moduleQuerySchema = z.object({
	q: z.string().max(200).optional(),
	state: z.enum(MODULE_STATES).optional(),
	kind: z.enum(MODULE_KINDS).optional()
});

// matches on the machine name or the label, case-insensitively
export function searchModules(manifest: ModuleManifest, query: ModuleQuery = {}): ModuleRow[] {
	const q = (query.q ?? '').trim().toLowerCase();
	return manifest.modules.filter(
		(row) =>
			(q === '' || row.name.includes(q) || row.label.toLowerCase().includes(q)) &&
			(query.state === undefined || row.state === query.state) &&
			(query.kind === undefined || row.kind === query.kind)
	);
}

export const moduleListItemSchema = moduleRowBase.extend({
	installed: z.boolean().nullable()
});
export type ModuleListItem = z.infer<typeof moduleListItemSchema>;

export const moduleConflictSchema = z.object({
	requires: z.string(),
	constraint: z.string(),
	installed: z.string().nullable(),
	reason: z.enum(CONFLICT_REASONS)
});
export type ModuleConflict = z.infer<typeof moduleConflictSchema>;

export const moduleCheckSchema = z.object({
	ok: z.boolean(),
	conflicts: z.array(moduleConflictSchema),
	message: z.string().min(1)
});
export type ModuleCheck = z.infer<typeof moduleCheckSchema>;

// the three steps of an install as plain data
export const INSTALL_STEPS = [
	{ id: 'check', title: 'Check', wired: true },
	{ id: 'install', title: 'Install', wired: true },
	{ id: 'enable', title: 'Enable', wired: true }
] as const;
export type InstallStepId = (typeof INSTALL_STEPS)[number]['id'];

// the composer name is vendor/project; the site enables and removes a module by its project name
export const machineName = (name: string): string => name.slice(name.indexOf('/') + 1);

// the rule for taking a module from the list; the service applies it before an install starts and
// the engine applies it again before it calls the site
export function installRefusal(
	row: Pick<ModuleRow, 'state' | 'shipping' | 'reason'> | undefined,
	confirm: boolean
): string | null {
	if (row === undefined) return 'That module is not on the list.';
	if (row.shipping) return 'This module is already included with every site.';
	if (row.state === 'blocked') return row.reason ?? 'This module cannot run here.';
	if (row.state === 'untested' && !confirm) {
		return 'This module has never been run on a site. Confirm that you want to install it anyway.';
	}
	return null;
}

export const moduleOperationSchema = z.strictObject({
	name: z.string().min(1).max(200),
	confirm: z.boolean().optional()
});
export type ModuleOperationBody = z.infer<typeof moduleOperationSchema>;

export const themeDefaultSchema = z.strictObject({
	name: z.string().min(1).max(200),
	target: z.enum(['default', 'admin'])
});
export type ThemeDefaultBody = z.infer<typeof themeDefaultSchema>;
