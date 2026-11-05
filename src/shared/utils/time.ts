import { DateTime, type DurationLikeObject } from 'luxon';
import { ApiError } from '../errors';

const systemClock = () => DateTime.utc();

let clock: () => DateTime = systemClock;

export function setClock(next: (() => DateTime) | null): void {
	clock = next ?? systemClock;
}

export function nowUtc(): DateTime {
	return clock();
}

export function parseIso(text: string): DateTime {
	const parsed = DateTime.fromISO(text, { zone: 'utc' });
	if (!parsed.isValid) throw new ApiError('validation', 'Expected an ISO 8601 timestamp');
	return parsed;
}

export function addDuration(time: DateTime, duration: DurationLikeObject): DateTime {
	return time.plus(duration);
}
