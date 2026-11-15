import { describe, expect, it } from 'vitest';
import { guardRemoval, REMOVAL_ORDER } from '../../../src/server/domain/module-removal';
import type { ModuleManifest } from '../../../src/shared/modules';

const census: ModuleManifest = {
	modules: [
		{
			name: 'drupal/token',
			label: 'Token',
			kind: 'unknown',
			state: 'verified',
			shipping: true,
			needs: []
		},
		{
			name: 'drupal/pathauto',
			label: 'Pathauto',
			kind: 'unknown',
			state: 'verified',
			shipping: false,
			needs: []
		},
		{
			name: 'drupal/paragraphs',
			label: 'Paragraphs',
			kind: 'unknown',
			state: 'untested',
			shipping: false,
			needs: []
		}
	]
};

const input = (patch: Partial<Parameters<typeof guardRemoval>[0]> = {}) => ({
	name: 'drupal/pathauto',
	enabledModules: ['pathauto', 'token'],
	dependents: [] as string[] | null,
	census,
	...patch
});

describe('guardRemoval', () => {
	it.each([
		[
			'a name that is not on the list',
			{ name: 'drupal/nope' },
			'That module is not on the list.'
		],
		[
			'a module in the pack',
			{ name: 'drupal/token' },
			'Token is included with every site and cannot be removed.'
		],
		[
			'a module that is not enabled',
			{ enabledModules: ['token'] },
			'Pathauto is not enabled on this site, so there is nothing to remove.'
		],
		[
			'one enabled dependent',
			{ enabledModules: ['pathauto', 'views_ui'], dependents: ['views_ui'] },
			'Pathauto is needed by views_ui, which is enabled. Turn it off first.'
		],
		[
			'two enabled dependents',
			{ enabledModules: ['pathauto', 'a', 'b'], dependents: ['a', 'b'] },
			'Pathauto is needed by a and b, which are enabled. Turn them off first.'
		],
		[
			'three enabled dependents',
			{ enabledModules: ['pathauto', 'a', 'b', 'c'], dependents: ['a', 'b', 'c'] },
			'Pathauto is needed by a, b and c, which are enabled. Turn them off first.'
		]
	] as const)('refuses %s with its reason unedited', (_label, patch, reason) => {
		const verdict = guardRemoval(input(patch as never));
		expect(verdict).toMatchObject({ ok: false, reason });
	});

	it('names only the dependents that are enabled', () => {
		const verdict = guardRemoval(
			input({ enabledModules: ['pathauto', 'a'], dependents: ['a', 'off_one'] })
		);
		expect(verdict).toMatchObject({ ok: false, blockedBy: ['a'] });
	});

	it('allows a removal when every dependent is off or none exists', () => {
		for (const dependents of [[], ['off_one']]) {
			expect(guardRemoval(input({ dependents }))).toMatchObject({ ok: true });
		}
	});

	it('states the order and returns what the caller says would be deleted', () => {
		const verdict = guardRemoval(
			input({ wouldDelete: ['pathauto.settings', 'pathauto.pattern.page'] })
		);
		expect(verdict).toEqual({
			ok: true,
			order: REMOVAL_ORDER,
			orderNote:
				'The site uninstalls Pathauto first. Its files are removed only after that succeeds.',
			wouldDelete: ['pathauto.settings', 'pathauto.pattern.page']
		});
		expect(REMOVAL_ORDER).toEqual(['uninstall', 'remove-files']);
	});

	it('returns an empty list when the caller supplies none', () => {
		expect(guardRemoval(input())).toMatchObject({ ok: true, wouldDelete: [] });
	});

	it('runs only the static checks while the dependents are not known', () => {
		expect(guardRemoval(input({ dependents: null }))).toMatchObject({ ok: true });
		expect(guardRemoval(input({ dependents: null, name: 'drupal/token' }))).toMatchObject({
			ok: false
		});
	});

	it('removes an untested module like any other', () => {
		const verdict = guardRemoval(
			input({ name: 'drupal/paragraphs', enabledModules: ['paragraphs'] })
		);
		expect(verdict).toMatchObject({ ok: true });
	});
});
