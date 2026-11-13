import { z } from 'zod';

export const ESTATE_VERSION = { major: 1, minor: 0 } as const;
export const ESTATE_CONTRACT = 'estate';

// technical bounds: the request body and the row table, not plan caps
export const ESTATE_LIMITS = {
	rows: 1000,
	textBytes: 1_048_576,
	hostnameChars: 253,
	pathChars: 200,
	aliasesPerRow: 40,
	noteChars: 300,
	unprovenHostsPerRun: 5,
	rejectedShown: 200
} as const;

export const REPORT_COLUMNS = [
	'number',
	'class',
	'state',
	'basis',
	'reconciled',
	'findings',
	'missing',
	'effort'
] as const;

export const INVENTORY_COLUMNS = [
	'hostname',
	'aliases',
	'server',
	'docroot',
	'site_dir',
	'database_host',
	'database_name',
	'table_prefix',
	'site_uuid',
	'cms',
	'version',
	'owner_note'
] as const;

export const ROW_CLASSES = [
	'ready',
	'automatic upgrade',
	'needs decision',
	'unsupported',
	'information'
] as const;
export const FINDING_CLASSES = [
	'automatic',
	'requires choice',
	'unsupported',
	'information'
] as const;
export const ROW_STATES = [
	'pending',
	'checking',
	'done',
	'needs access',
	'needs proof',
	'could not check',
	'skipped'
] as const;
export const ASSESSMENT_STATES = [
	'preparing',
	'running',
	'finished',
	'cancelled',
	'failed'
] as const;
export const IDENTITY_BASES = ['survey', 'columns', 'hostname'] as const;
export const CMS_VALUES = ['drupal', 'wordpress', 'joomla', 'unknown'] as const;

export const rowClass = z.enum(ROW_CLASSES);
export const findingClass = z.enum(FINDING_CLASSES);
export const rowState = z.enum(ROW_STATES);
export const assessmentState = z.enum(ASSESSMENT_STATES);

const text = (max: number) => z.string().max(max);

export const inventoryRowSchema = z.strictObject({
	hostname: text(ESTATE_LIMITS.hostnameChars).min(1),
	aliases: z.array(text(ESTATE_LIMITS.hostnameChars)).max(ESTATE_LIMITS.aliasesPerRow),
	server: text(ESTATE_LIMITS.hostnameChars),
	docroot: text(ESTATE_LIMITS.pathChars),
	siteDir: text(ESTATE_LIMITS.pathChars),
	databaseHost: text(ESTATE_LIMITS.hostnameChars),
	databaseName: text(ESTATE_LIMITS.pathChars),
	tablePrefix: text(ESTATE_LIMITS.pathChars),
	siteUuid: text(64),
	cms: z.enum(CMS_VALUES),
	version: text(40),
	ownerNote: text(ESTATE_LIMITS.noteChars)
});

// the sensitive parts are SHA-256 hashed, so an exported report names no path or endpoint
export const sourceSiteIdSchema = z.strictObject({
	hostFingerprint: z.string(),
	docroots: z.array(z.string()),
	siteDirectory: z.string(),
	siteUri: z.string(),
	databaseEndpoint: z.string(),
	schema: z.string(),
	prefix: z.string(),
	siteUuid: z.string()
});

export const findingSchema = z.strictObject({
	status: findingClass,
	title: z.string(),
	detail: z.string()
});

export const rowVerdictSchema = z.strictObject({
	class: rowClass,
	state: rowState,
	basis: z.enum(IDENTITY_BASES),
	reconciled: z.boolean(),
	missing: z.string().nullable(),
	findings: z.array(findingSchema)
});

export const reportCountsSchema = z.strictObject({
	sites: z.int().nonnegative(),
	byClass: z.record(rowClass, z.int().nonnegative()),
	byState: z.record(rowState, z.int().nonnegative()),
	notReconciled: z.int().nonnegative(),
	sharedDatabases: z.int().nonnegative(),
	duplicateDomains: z.int().nonnegative(),
	surveyed: z.int().nonnegative()
});

export const reportSchema = z.strictObject({
	counts: reportCountsSchema,
	effort: z.strictObject({
		value: z.null(),
		label: z.literal('Not estimated'),
		reason: z.string()
	}),
	windows: z.strictObject({ value: z.null(), label: z.literal('Not estimated') })
});

export type InventoryRow = z.infer<typeof inventoryRowSchema>;
export type SourceSiteId = z.infer<typeof sourceSiteIdSchema>;
export type RowClass = z.infer<typeof rowClass>;
export type RowState = z.infer<typeof rowState>;
export type AssessmentState = z.infer<typeof assessmentState>;
export type EstateFinding = z.infer<typeof findingSchema>;
export type RowVerdict = z.infer<typeof rowVerdictSchema>;
export type EstateReport = z.infer<typeof reportSchema>;

export const schemas = {
	inventoryRow: inventoryRowSchema,
	sourceSiteId: sourceSiteIdSchema,
	rowVerdict: rowVerdictSchema,
	report: reportSchema
};
