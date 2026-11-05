import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatMoney } from '../../../../src/shared/utils/format';
import { thrownBy } from '../../server/utils/support';

describe('formatBytes', () => {
	it.each([
		[0, '0 B'],
		[1023, '1023 B'],
		[1024, '1 KB'],
		[1536, '1.5 KB'],
		[1048576, '1 MB']
	])('formats %i as %j', (bytes, expected) => {
		expect(formatBytes(bytes)).toBe(expected);
	});

	it('refuses a negative or fractional count', () => {
		expect(() => formatBytes(-1)).toThrow(RangeError);
		expect(() => formatBytes(1.5)).toThrow(RangeError);
	});
});

describe('formatDuration', () => {
	it.each([
		[0, '0ms'],
		[250, '250ms'],
		[1000, '1s'],
		[60_000, '1m'],
		[90_000, '1m 30s'],
		[3_600_000, '1h'],
		[90_061_000, '1d 1h 1m 1s']
	])('formats %i ms as %j', (ms, expected) => {
		expect(formatDuration(ms)).toBe(expected);
	});

	it('refuses a negative duration', () => {
		expect(() => formatDuration(-5)).toThrow(RangeError);
	});
});

describe('formatMoney', () => {
	it('formats integer cents in the currency', () => {
		expect(formatMoney(1999, 'USD')).toBe('$19.99');
		expect(formatMoney(100000, 'USD')).toBe('$1,000.00');
		expect(formatMoney(-250, 'USD')).toBe('-$2.50');
	});

	it('uses the currency minor unit count', () => {
		expect(formatMoney(1500, 'JPY')).toBe(`${String.fromCharCode(0xa5)}1,500`);
	});

	it('keeps every digit of a large amount', () => {
		expect(formatMoney(9007199254740991, 'USD')).toBe('$90,071,992,547,409.91');
	});

	it('refuses a float', () => {
		expect(thrownBy(() => formatMoney(19.99, 'USD'))).toBeInstanceOf(RangeError);
	});
});
