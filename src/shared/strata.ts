import { z } from 'zod';

export const STRATA_MODULE = 'earth-app/strata';

export const STRATA_ALLOCATIONS = ['light', 'detailed'] as const;
export type StrataAllocation = (typeof STRATA_ALLOCATIONS)[number];

export const strataAllocationSchema = z.enum(STRATA_ALLOCATIONS);

export const DEFAULT_ALLOCATION: StrataAllocation = 'light';

export const STRATA_CAPTURES_STATEMENTS: Record<StrataAllocation, boolean> = {
	light: false,
	detailed: true
};

// history is sealed on the worker's cron interval, so no setting saves it more often
export const STRATA_RECOVERY_SECONDS = 900;

export const STRATA_ALLOCATION_LABELS: Record<StrataAllocation, string> = {
	light: 'Light',
	detailed: 'Detailed'
};

export const STRATA_ALLOCATION_TEXT: Record<StrataAllocation, string> = {
	light: 'Records changes made through the site and saves history every 15 minutes. Uses the least of the site allowance.',
	detailed:
		'Also records every database statement. Uses about twice as much of the site allowance as Light.'
};

export function allocationAllowed(allocation: StrataAllocation, free: boolean): boolean {
	return !free || allocation === 'light';
}

export const STRATA_FREE_REASON = 'strata_free_confirmation';

export const STRATA_FREE_WARNING =
	'Strata writes its history into the database of this site. On the free plan that spends the same daily write allowance the site uses to serve pages and run its admin. In our measurement on a typical mix of edits, Light took about 27 percent of the write headroom a free site has for its own changes. When the allowance runs out the site slows its writes until the next day.';

export const STRATA_STORE_STATES = ['none', 'ready', 'failed'] as const;
export type StrataStoreState = (typeof STRATA_STORE_STATES)[number];

// short codes the engine records when the store could not be set up
export const STRATA_STORE_REASONS = {
	site_needs_update: 'The site needs an update before it can use storage.',
	token_quota: 'The storage allowance for new sites is used up.',
	storage_failed: 'The storage service did not accept the request.',
	site_refused: 'The site did not accept the storage settings.'
} as const;
export type StrataStoreReason = keyof typeof STRATA_STORE_REASONS;

// a self-managed site is only read, never written to, so this is what the stored connection shows
export const STRATA_STORAGE_CHECKS = [
	'ok',
	'needs_object_storage',
	'needs_wider_token',
	'unchecked'
] as const;
export type StrataStorageCheck = (typeof STRATA_STORAGE_CHECKS)[number];

export const STRATA_STORAGE_NOTES: Record<
	Exclude<StrataStorageCheck, 'ok'>,
	{ label: string; action: string }
> = {
	needs_object_storage: {
		label: 'Needs Object Storage',
		action: 'Turn on R2 for your Cloudflare account, then check the connection again.'
	},
	needs_wider_token: {
		label: 'Needs a Wider Token',
		action: 'Add the Workers R2 Storage Edit permission to the connected token, then check the connection again.'
	},
	unchecked: {
		label: 'Not Checked Yet',
		action: 'Check the Cloudflare connection to see whether Strata can store backups on your account.'
	}
};

export function storageCheckOf(
	storage: { state: 'granted' | 'missing' | 'not-enabled' | 'unknown' } | undefined
): StrataStorageCheck {
	if (storage?.state === 'granted') return 'ok';
	if (storage?.state === 'not-enabled') return 'needs_object_storage';
	if (storage?.state === 'missing') return 'needs_wider_token';
	return 'unchecked';
}

export const strataStatusSchema = z.object({
	allocation: strataAllocationSchema,
	capturesStatements: z.boolean(),
	recoverySeconds: z.number().int().positive(),
	applied: z.boolean(),
	confirmedFreeAt: z.number().int().nullable(),
	store: z.enum(STRATA_STORE_STATES),
	storeReason: z.string().nullable(),
	// null on a managed site, which Drupflare stores for
	storage: z.enum(STRATA_STORAGE_CHECKS).nullable()
});
export type StrataStatus = z.infer<typeof strataStatusSchema>;

export const strataAllocationBodySchema = z.strictObject({
	allocation: strataAllocationSchema
});

export function statusOf(
	allocation: StrataAllocation,
	kept: {
		appliedAt: number | null;
		confirmedFreeAt: number | null;
		store?: StrataStoreState;
		storeReason?: string | null;
	} | null,
	storage: StrataStorageCheck | null = null
): StrataStatus {
	return {
		allocation,
		capturesStatements: STRATA_CAPTURES_STATEMENTS[allocation],
		recoverySeconds: STRATA_RECOVERY_SECONDS,
		applied: kept?.appliedAt != null,
		confirmedFreeAt: kept?.confirmedFreeAt ?? null,
		store: kept?.store ?? 'none',
		storeReason: kept?.storeReason ?? null,
		storage
	};
}
