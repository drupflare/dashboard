import { sha256Hex } from '@contracts/common';
import { SITE_CONFIG_REGISTRY } from './registry';

export const isSecret = (key: string): boolean => SITE_CONFIG_REGISTRY[key]?.widget === 'secret';

// a secret leaves the server only as whether one is set; the same marker maps to itself
export function maskSecret(key: string, value: unknown): unknown {
	if (!isSecret(key)) return value;
	return value === null || value === undefined || value === '' || value === 'Not Set'
		? 'Not Set'
		: 'Set';
}

// what an operation keeps in place of a secret it compares against
export function secretDigest(value: unknown): Promise<string> {
	return sha256Hex(JSON.stringify(value ?? null));
}
