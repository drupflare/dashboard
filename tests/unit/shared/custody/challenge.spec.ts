import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../../../../contracts/src/common';
import {
	CHALLENGE_PREFIX,
	deriveChallenge,
	loadChallengeKeys,
	type ChallengeInput
} from '../../../../src/shared/custody/challenge';
import { CryptoError } from '../../../../src/shared/custody/envelope';

const kek = (fill: number) => toBase64Url(new Uint8Array(32).fill(fill));
const INPUT: ChallengeInput = { siteId: 'site_a', hostname: 'www.example.edu', epoch: 1 };

async function valueOf(secrets: Record<string, string>, input: ChallengeInput = INPUT) {
	return (await deriveChallenge(await loadChallengeKeys(secrets), input)).value;
}

describe('the ownership value', () => {
	it('is stable for the same site, hostname, epoch and key', async () => {
		expect(await valueOf({ KEK_V1: kek(1) })).toBe(await valueOf({ KEK_V1: kek(1) }));
	});

	it('reads as a prefix and 32 lowercase base32 characters', async () => {
		const value = await valueOf({ KEK_V1: kek(1) });
		expect(value.startsWith(CHALLENGE_PREFIX)).toBe(true);
		expect(value.slice(CHALLENGE_PREFIX.length)).toMatch(/^[a-z2-7]{32}$/);
	});

	it.each([
		['site', { siteId: 'site_b' }],
		['hostname', { hostname: 'example.edu' }],
		['epoch', { epoch: 2 }]
	])('changes when the %s changes', async (_name, over) => {
		const secrets = { KEK_V1: kek(1) };
		expect(await valueOf(secrets, { ...INPUT, ...over })).not.toBe(await valueOf(secrets));
	});

	it('changes with the key, so it cannot be worked out from public data', async () => {
		expect(await valueOf({ KEK_V1: kek(1) })).not.toBe(await valueOf({ KEK_V1: kek(2) }));
	});

	it('shares nothing with the claim id, the site id or the hostname', async () => {
		const value = await valueOf({ KEK_V1: kek(1) });
		for (const public_ of ['site_a', 'www.example.edu', 'op_a', 'org_a', '1']) {
			expect(value.slice(CHALLENGE_PREFIX.length)).not.toContain(public_);
		}
	});

	it('does not confuse inputs whose parts run together', async () => {
		const secrets = { KEK_V1: kek(1) };
		const a = await valueOf(secrets, { siteId: 'site_a', hostname: 'b.example.edu', epoch: 1 });
		const b = await valueOf(secrets, { siteId: 'site_ab', hostname: '.example.edu', epoch: 1 });
		expect(a).not.toBe(b);
	});

	it('shows the newest key and still accepts a value made under an older one', async () => {
		const old = await valueOf({ KEK_V1: kek(1) });
		const ring = await deriveChallenge(
			await loadChallengeKeys({ KEK_V1: kek(1), KEK_V2: kek(2) }),
			INPUT
		);
		expect(ring.value).toBe(await valueOf({ KEK_V2: kek(2) }));
		expect(ring.accepted).toHaveLength(2);
		expect(ring.accepted).toContain(old);
		expect(ring.value).not.toBe(old);
	});

	it('refuses an empty ring and a malformed key', async () => {
		await expect(loadChallengeKeys({})).rejects.toMatchObject({ code: 'no_keys' });
		await expect(loadChallengeKeys({ KEK_V1: 'short' })).rejects.toBeInstanceOf(CryptoError);
	});
});
