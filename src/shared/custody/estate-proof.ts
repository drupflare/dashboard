import { utf8 } from '@contracts/common';
import type { ChallengeKeys } from './challenge';

export const ESTATE_PROOF_LABEL = '_drupflare-estate';
export const ESTATE_PROOF_PREFIX = 'drupflare-estate=';
export const ESTATE_PROOF_PATH = '/.well-known/drupflare-estate.txt';

// a context of its own, so a value made here can never double as a domain attach record
const CONTEXT = 'drupflare.estate-proof.v1';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const TOKEN_BYTES = 20;

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

export interface EstateProof {
	value: string;
	// every value the key ring can produce, newest first, so a rotation keeps a published record valid
	accepted: string[];
}

// bound to the organisation and the registrable domain, never to a site
export async function deriveEstateProof(
	keys: ChallengeKeys,
	input: { orgId: string; domain: string }
): Promise<EstateProof> {
	const versions = [...keys.keys.keys()].sort((a, b) => b - a);
	const message = utf8(JSON.stringify([CONTEXT, input.orgId, input.domain]));
	const accepted = await Promise.all(
		versions.map(async (version) => {
			const mac = new Uint8Array(
				await crypto.subtle.sign('HMAC', keys.keys.get(version) as CryptoKey, message)
			);
			return `${ESTATE_PROOF_PREFIX}${base32(mac.subarray(0, TOKEN_BYTES))}`;
		})
	);
	return { value: accepted[0] as string, accepted };
}
