import { describe, expect, it } from 'vitest';
import { OPERATION_TYPES } from '../../../contracts/src/operations';
import { DEFAULT_HOLD_MS } from '../../../dispatch/src/registry';
import {
	OPERATION_COPY,
	SITE_HOLD_DAYS,
	copyFor,
	type OperationCopy
} from '../../../src/shared/operation-copy';

const SITE = 'site_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const COVERED = ['site.create', 'site.delete', 'site.upgrade', 'backup.create', 'backup.restore'];

describe('operation copy', () => {
	it('covers the five operations the progress screen names, and no other', () => {
		expect(Object.keys(OPERATION_COPY).sort()).toEqual([...COVERED].sort());
		for (const type of COVERED) expect(OPERATION_TYPES).toContain(type);
	});

	it('gives every entry a title, a running line, a success line and a failure title in plain ASCII', () => {
		for (const type of COVERED) {
			const copy = copyFor(type as never);
			for (const field of ['title', 'running', 'success', 'failure'] as const) {
				expect(copy[field], `${type} ${field}`).toMatch(/^[\x20-\x7e]+$/);
			}
			expect(copy.failure, type).not.toBe(copy.title);
		}
	});

	it('titles read as the screen heading for each operation', () => {
		expect(copyFor('site.create').title).toBe('Creating Your Site');
		expect(copyFor('site.delete').title).toBe('Deleting Your Site');
		expect(copyFor('site.delete').success).toMatch(/^Site deleted/);
		expect(copyFor('site.delete').failure).toBe('Could Not Delete the Site');
	});

	it('links a finished delete to Sites and every other site operation back to the site', () => {
		const operation = { targetIds: [SITE] };
		expect(copyFor('site.delete').link(operation)).toEqual({
			to: '/sites',
			label: 'Back to Sites'
		});
		for (const type of ['site.upgrade', 'backup.create', 'backup.restore'] as const) {
			expect(copyFor(type).link(operation), type).toEqual({
				to: `/sites/${SITE}`,
				label: 'Back to the Site'
			});
		}
	});

	it('shows no link after a create, which has its own panel, and sends a failed create to the form', () => {
		const operation = { targetIds: [SITE] };
		expect(copyFor('site.create').link(operation)).toBeNull();
		expect(copyFor('site.create').failureLink(operation)).toEqual({
			to: '/new',
			label: 'Try Again'
		});
		expect(copyFor('site.delete').failureLink(operation).to).toBe(`/sites/${SITE}`);
	});

	it('falls back to Sites when an operation names no site', () => {
		expect(copyFor('site.upgrade').link({ targetIds: [] })).toEqual({
			to: '/sites',
			label: 'Back to Sites'
		});
	});

	it('uses generic words for a type it has no copy for, and while the type is unknown', () => {
		const generic: OperationCopy = copyFor(undefined);
		expect(copyFor('repair.run')).toBe(generic);
		expect(generic.title).toBe('Operation Progress');
		expect(generic.link({ targetIds: [SITE] })).toEqual({
			to: '/sites',
			label: 'Back to Sites'
		});
	});

	it('states the same hold as the registry that enforces it', () => {
		expect(SITE_HOLD_DAYS * 86_400_000).toBe(DEFAULT_HOLD_MS);
		expect(copyFor('site.delete').success).toContain(`${SITE_HOLD_DAYS} days`);
	});
});
