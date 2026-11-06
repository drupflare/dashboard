import { isReserved, isValidName, shardKey } from '../../src/shared/names';
import type { SyncKv } from './storage';

// placeholder policy, unreviewed: how long a released name stays out of reuse
export const DEFAULT_HOLD_MS = 90 * 86_400_000;

// placeholder policy, unreviewed: the longest hold a caller can ask for
export const MAX_HOLD_MS = 365 * 86_400_000;

// below zero is zero, above the maximum is the maximum, not a number is the default
export function clampHold(holdMs: number): number {
	if (!Number.isFinite(holdMs)) return DEFAULT_HOLD_MS;
	return Math.min(Math.max(holdMs, 0), MAX_HOLD_MS);
}

export type NameRecord =
	{ state: 'taken'; siteId: string } | { state: 'held'; until: number } | { state: 'tombstoned' };

export type ReserveAnswer = 'reserved' | 'held' | 'taken' | 'reserved-word' | 'invalid';
export type ReleaseAnswer = 'released' | 'tombstoned' | 'not-owner' | 'unknown';

const key = (name: string) => `name:${name}`;

// a name is free when it has no record or its hold has run out; a tombstone never runs out
function isFree(record: NameRecord | undefined, now: number): boolean {
	return record === undefined || (record.state === 'held' && now >= record.until);
}

// one synchronous read and write: inside a Durable Object no second call can run between them
export function reserveIn(
	kv: SyncKv,
	name: string,
	siteId: string,
	now: number,
	shard?: string
): ReserveAnswer {
	if (!isValidName(name)) return 'invalid';
	// a name sent to the wrong shard would be unique in no shard, so refuse it
	if (shard !== undefined && shardKey(name) !== shard) return 'invalid';
	if (isReserved(name)) return 'reserved-word';
	const record = kv.get<NameRecord>(key(name));
	if (record?.state === 'taken') return record.siteId === siteId ? 'reserved' : 'taken';
	if (!isFree(record, now)) return 'held';
	kv.put(key(name), { state: 'taken', siteId } satisfies NameRecord);
	return 'reserved';
}

export function releaseIn(
	kv: SyncKv,
	name: string,
	siteId: string,
	now: number,
	holdMs: number = DEFAULT_HOLD_MS
): ReleaseAnswer {
	const record = kv.get<NameRecord>(key(name));
	if (record === undefined) return 'unknown';
	if (record.state !== 'taken' || record.siteId !== siteId) return 'not-owner';
	kv.put(key(name), { state: 'held', until: now + clampHold(holdMs) } satisfies NameRecord);
	return 'released';
}

export function tombstoneIn(kv: SyncKv, name: string, siteId: string): ReleaseAnswer {
	const record = kv.get<NameRecord>(key(name));
	if (record === undefined) return 'unknown';
	if (record.state !== 'taken' || record.siteId !== siteId) return 'not-owner';
	kv.put(key(name), { state: 'tombstoned' } satisfies NameRecord);
	return 'tombstoned';
}
