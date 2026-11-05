import { DateTime } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import { addDuration, nowUtc, parseIso, setClock } from '../../../../src/shared/utils/time';
import { thrownBy } from '../../server/utils/support';

afterEach(() => {
	setClock(null);
});

describe('nowUtc', () => {
	it('reads the real clock in UTC by default', () => {
		const now = nowUtc();
		expect(now.zoneName).toBe('UTC');
		expect(Math.abs(now.toMillis() - Date.now())).toBeLessThan(5000);
	});

	it('uses the clock a test sets', () => {
		setClock(() => DateTime.fromISO('2026-01-02T03:04:05Z', { zone: 'utc' }));
		expect(nowUtc().toISO()).toBe('2026-01-02T03:04:05.000Z');
	});
});

describe('parseIso', () => {
	it('parses an offset timestamp into UTC', () => {
		const parsed = parseIso('2026-11-05T14:00:00+02:00');
		expect(parsed.zoneName).toBe('UTC');
		expect(parsed.toISO()).toBe('2026-11-05T12:00:00.000Z');
	});

	it('refuses text that is not a timestamp', () => {
		expect(thrownBy(() => parseIso('next tuesday'))).toMatchObject({ code: 'validation' });
	});
});

describe('addDuration', () => {
	it('adds the duration', () => {
		const start = parseIso('2026-11-05T12:00:00Z');
		expect(addDuration(start, { minutes: 10 }).toISO()).toBe('2026-11-05T12:10:00.000Z');
	});
});
