import { describe, expect, it } from 'vitest';
import {
	ENVIRONMENT_STATUSES,
	EnvironmentNameError,
	canMoveEnvironment,
	environmentLabel,
	isEnvironmentStatus,
	labelOfHost,
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
