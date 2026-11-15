import { describe, expect, it } from 'vitest';
import {
	checkModifyFiles,
	MODIFY_MAX_API_BYTES,
	MODIFY_MAX_REQUEST_BYTES,
	modifyNameProblem,
	modifyPackageOf,
	modifyPathProblem,
	modifyRequestProblem,
	modifyRoot
} from '../../../src/shared/modify';

const file = (path: string, content = '<?php') => ({ path, content });
const OK = 'modules/custom/my_module/my_module.module';

describe('modifyPathProblem', () => {
	it.each([
		[OK, null],
		['themes/custom/mine/css/a.css', null],
		['profiles/custom/mine/mine.info.yml', null],
		[
			'/modules/custom/a/b.php',
			'Use a path relative to the Drupal root, with forward slashes.'
		],
		[
			'modules\\custom\\a\\b.php',
			'Use a path relative to the Drupal root, with forward slashes.'
		],
		['modules/custom/a/../b.php', 'A path cannot hold .. or empty parts.'],
		['modules//custom/a/b.php', 'A path cannot hold .. or empty parts.'],
		[
			'modules/custom/a/b c.php',
			'A path can hold letters, digits, dots, dashes and underscores.'
		],
		['core/lib/Drupal.php', expect.stringContaining('modules/custom/<name>/')],
		['modules/custom/A/b.php', expect.stringContaining('modules/custom/<name>/')],
		['modules/contrib/a/b.php', expect.stringContaining('modules/custom/<name>/')]
	])('%s', (path, problem) => {
		expect(modifyPathProblem(path)).toEqual(problem);
	});
});

describe('names and roots', () => {
	it('accepts a machine name and refuses anything else', () => {
		expect(modifyNameProblem('my_module2')).toBeNull();
		for (const bad of ['', 'My', '2fast', 'a-b', 'a'.repeat(65)]) {
			expect(modifyNameProblem(bad)).toContain('machine name');
		}
	});

	it('builds the folder per kind and reads the package back from a path', () => {
		expect(modifyRoot('module', 'a')).toBe('modules/custom/a/');
		expect(modifyRoot('theme', 'a')).toBe('themes/custom/a/');
		expect(modifyRoot('profile', 'a')).toBe('profiles/custom/a/');
		expect(modifyPackageOf(OK)).toBe('my_module');
		expect(modifyPackageOf('core/x.php')).toBeNull();
	});
});

describe('checkModifyFiles', () => {
	it('accepts one package and counts decoded bytes', () => {
		const result = checkModifyFiles([
			file(OK),
			{ path: 'modules/custom/my_module/b.txt', content: 'aGk=', encoding: 'base64' }
		]);
		expect(result).toMatchObject({
			ok: true,
			value: {
				package: 'my_module',
				bytes: 7,
				files: [
					{ path: OK, source: '<?php', bytes: 5 },
					{ path: 'modules/custom/my_module/b.txt', source: 'hi', bytes: 2 }
				]
			}
		});
	});

	it('names each problem against the index of its file', () => {
		const result = checkModifyFiles([
			file(OK),
			file(OK),
			file('modules/custom/other/a.php'),
			file('core/a.php'),
			{ path: 'modules/custom/my_module/c.bin', content: '/w==', encoding: 'base64' },
			{ path: 'modules/custom/my_module/d.bin', content: '***', encoding: 'base64' }
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.problems.map((problem) => problem.file)).toEqual([1, 2, 3, 4, 5]);
		expect(result.problems[0]!.message).toBe('This path is listed twice.');
		expect(result.problems[1]!.message).toContain('same module, theme or profile');
		expect(result.problems[4]!.message).toContain('not base64 for UTF-8 text');
	});

	it('refuses a file that cannot fit one request and a set that adds up past the ceiling', () => {
		const big = 'x'.repeat(MODIFY_MAX_REQUEST_BYTES);
		const one = checkModifyFiles([file(OK, big)]);
		expect(one.ok === false && one.problems[0]!.message).toContain('too large to send');
		const half = 'x'.repeat(MODIFY_MAX_REQUEST_BYTES / 2 + 1);
		const sum = checkModifyFiles([
			file(OK, half),
			file('modules/custom/my_module/b.php', half)
		]);
		expect(sum.ok === false && sum.problems).toEqual([
			{ file: null, message: expect.stringContaining('add up to more than 2 MiB') }
		]);
	});

	it('returns no package for an empty list', () => {
		expect(checkModifyFiles([])).toEqual({ ok: false, problems: [] });
	});
});

describe('modifyRequestProblem', () => {
	it('passes a small body and names the size of one past the dashboard cap', () => {
		expect(modifyRequestProblem({ files: [file(OK)], note: 'x' })).toBeNull();
		const message = modifyRequestProblem({ content: 'x'.repeat(MODIFY_MAX_API_BYTES) });
		expect(message).toContain('The dashboard takes up to 1 MiB');
	});
});
