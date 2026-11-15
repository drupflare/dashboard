import { describe, expect, it } from 'vitest';
import {
	ENVIRONMENT_STATUSES,
	EnvironmentNameError,
	HOUR_MS,
	PREVIEW_LIMIT,
	PREVIEW_TTL_DEFAULT_MS,
	PREVIEW_TTL_MAX_MS,
	canMoveEnvironment,
	clampPreviewTtl,
	environmentLabel,
	expiryText,
	freePreviewNumber,
	isEnvironmentStatus,
	labelOfHost,
	previewNumberOf,
	scratchLabel
} from '../../../src/shared/environments';
import { isValidName, suffixOwner } from '../../../src/shared/names';

describe('environment status vocabulary', () => {
	it('knows the five statuses and refuses any other word', () => {
		for (const status of ENVIRONMENT_STATUSES) expect(isEnvironmentStatus(status)).toBe(true);
		expect(isEnvironmentStatus('pending')).toBe(false);
	});

	it('moves forward only and never leaves deleted', () => {
		expect(canMoveEnvironment('creating', 'ready')).toBe(true);
		expect(canMoveEnvironment('ready', 'deleting')).toBe(true);
		expect(canMoveEnvironment('ready', 'creating')).toBe(false);
		for (const status of ENVIRONMENT_STATUSES) {
			expect(canMoveEnvironment('deleted', status)).toBe(false);
		}
	});
});

describe('environment names', () => {
	it('adds the paid suffix to a site label', () => {
		expect(environmentLabel('quiet-river', 'staging')).toBe('quiet-river-staging');
		expect(environmentLabel('quiet-river', 'dev')).toBe('quiet-river-dev');
		expect(environmentLabel('quiet-river', 'preview', 3)).toBe('quiet-river-preview-3');
	});

	it('refuses a label the names table rejects', () => {
		expect(() => environmentLabel('a'.repeat(60), 'staging')).toThrow(EnvironmentNameError);
		expect(() => environmentLabel('Bad_Label', 'dev')).toThrow(EnvironmentNameError);
	});

	it('gives a scratch site a valid name that only paid managed sites may hold', () => {
		const label = scratchLabel('op_abcdefghij');
		expect(isValidName(label)).toBe(true);
		expect(suffixOwner(label)).toBe('paid-managed');
		expect(scratchLabel('op_abcdefghij')).toBe(label);
		expect(scratchLabel('op_klmnopqrst')).not.toBe(label);
	});

	it('reads the site label from a host and drops a staging suffix', () => {
		expect(labelOfHost('quiet-river.drupflare.app')).toBe('quiet-river');
		expect(labelOfHost('quiet-river-stg.drupflare.app', '-stg')).toBe('quiet-river');
		expect(labelOfHost('quiet-river.drupflare.app', '-stg')).toBe('quiet-river');
	});
});

describe('preview numbers and lifetime', () => {
	it('picks the lowest free number and gives null at the limit', () => {
		expect(freePreviewNumber([])).toBe(1);
		expect(freePreviewNumber([1, 3])).toBe(2);
		expect(freePreviewNumber([1, 2, 3])).toBeNull();
		expect(freePreviewNumber([2], 2)).toBe(1);
		expect(freePreviewNumber([1, 2], 2)).toBeNull();
		expect(PREVIEW_LIMIT).toBeGreaterThan(0);
	});

	it('reads the number off a preview name and nothing off another name', () => {
		expect(previewNumberOf('quiet-river-preview-2')).toBe(2);
		expect(previewNumberOf('quiet-river-staging')).toBeNull();
		expect(previewNumberOf('quiet-river-preview-x')).toBeNull();
	});

	it('defaults the lifetime and keeps it between an hour and the ceiling', () => {
		expect(clampPreviewTtl(undefined)).toBe(PREVIEW_TTL_DEFAULT_MS);
		expect(clampPreviewTtl(1)).toBe(HOUR_MS);
		expect(clampPreviewTtl(PREVIEW_TTL_MAX_MS + 1)).toBe(PREVIEW_TTL_MAX_MS);
		expect(clampPreviewTtl(5 * HOUR_MS)).toBe(5 * HOUR_MS);
	});

	it('says how long a preview has left in hours, then days', () => {
		const now = 1_000_000;
		expect(expiryText(now - 1, now)).toBe('Deleted soon');
		expect(expiryText(now + 1, now)).toBe('Deleted in 1 hour');
		expect(expiryText(now + 5 * HOUR_MS, now)).toBe('Deleted in 5 hours');
		expect(expiryText(now + 47 * HOUR_MS, now)).toBe('Deleted in 47 hours');
		expect(expiryText(now + 48 * HOUR_MS, now)).toBe('Deleted in 2 days');
		expect(expiryText(now + 49 * HOUR_MS, now)).toBe('Deleted in 3 days');
	});
});
