import { describe, expect, it } from 'vitest';
import { safeRedirect } from '~/stores/session';

describe('safeRedirect', () => {
	it.each([
		['/sites', '/sites'],
		['/sites?page=2#top', '/sites?page=2#top']
	])('keeps the same-site path %s', (input, expected) => {
		expect(safeRedirect(input)).toBe(expected);
	});

	it.each<[unknown, string]>([
		['https://evil.example/', 'absolute url'],
		['//evil.example/', 'protocol-relative url'],
		['/\\evil.example', 'backslash variant'],
		['sites', 'relative path'],
		['', 'empty string'],
		[['/sites'], 'array'],
		[undefined, 'missing value']
	])('refuses %s (%s)', (input) => {
		expect(safeRedirect(input)).toBeNull();
	});
});
