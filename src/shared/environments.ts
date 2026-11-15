import { hashName, isValidName, suffixOwner } from './names';

export const ENVIRONMENT_KINDS = ['staging', 'dev', 'preview'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

// placeholders until the plan numbers are reviewed: a site holds this many previews at once, and a
// preview expires after the default unless the owner picks a time inside the ceiling
export const PREVIEW_LIMIT = 3;
export const HOUR_MS = 3_600_000;
export const PREVIEW_TTL_DEFAULT_MS = 72 * HOUR_MS;
export const PREVIEW_TTL_MAX_MS = 336 * HOUR_MS;

export function clampPreviewTtl(ttlMs: number | undefined): number {
	if (ttlMs === undefined) return PREVIEW_TTL_DEFAULT_MS;
	return Math.min(Math.max(ttlMs, HOUR_MS), PREVIEW_TTL_MAX_MS);
}

export function expiryText(ttlAt: number, now: number): string {
	const left = ttlAt - now;
	if (left <= 0) return 'Deleted soon';
	const hours = Math.ceil(left / HOUR_MS);
	if (hours < 48) return `Deleted in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
	return `Deleted in ${Math.ceil(hours / 24)} days`;
}

// the lowest preview number a site is not using, or null when it is at its limit
export function freePreviewNumber(taken: readonly number[], limit = PREVIEW_LIMIT): number | null {
	for (let number = 1; number <= limit; number++) {
		if (!taken.includes(number)) return number;
	}
	return null;
}

export function previewNumberOf(name: string): number | null {
	const match = /-preview-(\d+)$/.exec(name);
	return match === null ? null : Number(match[1]);
}

export const ENVIRONMENT_STATUSES = ['creating', 'ready', 'failed', 'deleting', 'deleted'] as const;
export type EnvironmentStatus = (typeof ENVIRONMENT_STATUSES)[number];

export const isEnvironmentStatus = (value: string): value is EnvironmentStatus =>
	(ENVIRONMENT_STATUSES as readonly string[]).includes(value);

// the statuses an environment may move to from each status
const NEXT: Record<EnvironmentStatus, readonly EnvironmentStatus[]> = {
	creating: ['ready', 'failed', 'deleting'],
	ready: ['deleting'],
	failed: ['deleting', 'deleted'],
	deleting: ['deleted', 'failed'],
	deleted: []
};

export const canMoveEnvironment = (from: EnvironmentStatus, to: EnvironmentStatus) =>
	NEXT[from].includes(to);

// the plain words the list shows for each status
export const ENVIRONMENT_STATUS_LABELS: Record<EnvironmentStatus, string> = {
	creating: 'Creating',
	ready: 'Ready',
	failed: 'Failed',
	deleting: 'Deleting',
	deleted: 'Deleted'
};

export const ENVIRONMENT_KIND_LABELS: Record<EnvironmentKind, string> = {
	staging: 'Staging',
	dev: 'Dev',
	preview: 'Preview'
};

// what the worker leaves out of a saved copy unless it is asked to carry secrets, from the export
// section of its recovery page; the worker returns no list of its own, so this is the dashboard's
export const SECRETS_NOT_CARRIED: readonly string[] = [
	'The site owner token, because the copy gets its own',
	'The Cloudflare sign-in token and client id',
	'Email sending settings',
	'The signing salt, so one-time sign-in links from the original do not work on the copy',
	'Git access tokens and webhook secrets'
];

// the label of a scratch site: the hash prefix the names table reserves for platform copies
export function scratchLabel(operationId: string): string {
	return `${hashName(operationId).toString(16).padStart(8, '0')}-verify`;
}

// the label a site's address starts with, less the suffix a staging deployment adds
export function labelOfHost(hostname: string, labelSuffix = ''): string {
	const label = hostname.split('.')[0] ?? hostname;
	return labelSuffix !== '' && label.endsWith(labelSuffix)
		? label.slice(0, -labelSuffix.length)
		: label;
}

export class EnvironmentNameError extends Error {
	constructor(readonly label: string) {
		super(`${label} is not a usable environment name`);
	}
}

// staging and dev add a fixed suffix to the site's own name; a preview adds a number
export function environmentLabel(siteLabel: string, kind: EnvironmentKind, number = 1): string {
	const label = kind === 'preview' ? `${siteLabel}-preview-${number}` : `${siteLabel}-${kind}`;
	// the suffix belongs to paid managed sites, so a label that does not carry it is a mistake here
	if (!isValidName(label) || suffixOwner(label) !== 'paid-managed') {
		throw new EnvironmentNameError(label);
	}
	return label;
}
