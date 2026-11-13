import { utf8 } from '@contracts/common';
import { readKeyMaterial } from './envelope';

export const CHALLENGE_LABEL = '_drupflare-challenge';
export const CHALLENGE_PREFIX = 'drupflare-verify=';

const CONTEXT = 'drupflare.domain-challenge.v1';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
// 20 bytes read as 32 base32 characters, 160 bits
const TOKEN_BYTES = 20;

export interface ChallengeKeys {
	keys: ReadonlyMap<number, CryptoKey>;
}

export interface ChallengeInput {
	siteId: string;
	hostname: string;
	// the epoch the hostname's claim carries once this site holds it
	epoch: number;
}

export interface Challenge {
	// what the page shows and the workflow expects first
	value: string;
	// every value the key ring can produce, newest first, so a rotation keeps a published record valid
	accepted: string[];
}

// a distinct HMAC key per ring version, derived with HKDF so the ring key itself never signs
export async function loadChallengeKeys(
	secrets: Readonly<Record<string, string | undefined>>
): Promise<ChallengeKeys> {
	const keys = new Map<number, CryptoKey>();
	for (const [version, raw] of readKeyMaterial(secrets)) {
		const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
		keys.set(
			version,
			await crypto.subtle.deriveKey(
				{
					name: 'HKDF',
					hash: 'SHA-256',
					salt: utf8(CONTEXT),
					info: utf8(`kek:${version}`)
				},
				base,
				{ name: 'HMAC', hash: 'SHA-256', length: 256 },
				false,
				['sign']
			)
		);
	}
	return { keys };
}

function base32(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	return out;
}

async function tokenWith(key: CryptoKey, input: ChallengeInput): Promise<string> {
	const message = utf8(JSON.stringify([CONTEXT, input.siteId, input.hostname, input.epoch]));
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
	return `${CHALLENGE_PREFIX}${base32(mac.subarray(0, TOKEN_BYTES))}`;
}

// the same inputs always give the same value; a new site, hostname or epoch gives a new one
export async function deriveChallenge(
	keys: ChallengeKeys,
	input: ChallengeInput
): Promise<Challenge> {
	const versions = [...keys.keys.keys()].sort((a, b) => b - a);
	const accepted = await Promise.all(
		versions.map((version) => tokenWith(keys.keys.get(version) as CryptoKey, input))
	);
	return { value: accepted[0] as string, accepted };
}
