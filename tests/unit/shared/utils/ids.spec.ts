import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId, parseId } from '../../../../src/shared/utils/ids';
import { thrownBy } from '../../server/utils/support';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('newId', () => {
	it('gives the prefix and a 26 character Crockford body', () => {
		expect(newId('site')).toMatch(/^site_[0-9A-HJKMNP-TV-Z]{26}$/);
	});

	it('encodes all-zero bytes as zeros', () => {
		vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
			new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
			return array;
		});
		expect(newId('site')).toBe('site_00000000000000000000000000');
	});

	it('encodes all-one bytes with the zero-padded final character', () => {
		vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
			new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xff);
			return array;
		});
		expect(newId('site')).toBe('site_ZZZZZZZZZZZZZZZZZZZZZZZZZW');
	});
});

describe('parseId', () => {
	const id = 'site_01ARZ3NDEKTSV4RRFFQ69G5FAV';

	it('returns an id with the expected prefix', () => {
		expect(parseId(id, 'site')).toBe(id);
	});

	it('refuses an id with a different prefix', () => {
		expect(thrownBy(() => parseId(id, 'org'))).toMatchObject({ code: 'validation' });
	});

	it('refuses a body outside the Crockford alphabet', () => {
		expect(thrownBy(() => parseId('site_01ARZ3NDEKTSV4RRFFQ69G5FAU', 'site'))).toMatchObject({
			code: 'validation'
		});
	});
});
