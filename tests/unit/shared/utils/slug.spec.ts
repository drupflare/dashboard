import { describe, expect, it } from 'vitest';
import { slugify } from '../../../../src/shared/utils/slug';

const acute = String.fromCharCode(0xe9);
const grave = String.fromCharCode(0xe0);

describe('slugify', () => {
	it.each([
		['Hello, World!', 'hello-world'],
		[`Caf${acute} D${acute}j${grave} vu`, 'cafe-deja-vu'],
		['  --A__b--  ', 'a-b'],
		['2026 Plan', '2026-plan'],
		['', '']
	])('turns %j into %j', (input, expected) => {
		expect(slugify(input)).toBe(expected);
	});
});
