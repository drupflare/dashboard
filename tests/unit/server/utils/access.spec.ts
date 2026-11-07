import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	accessConfigOf,
	verifyAccessToken,
	type AccessConfig
} from '../../../../src/server/utils/access';

const config: AccessConfig = { team: 'acme', audiences: ['aud-page'] };

let privateKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
	const pair = await generateKeyPair('RS256');
	privateKey = pair.privateKey;
	keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256' }] });
});

function token(
	claims: Record<string, unknown> = { email: 'Admin@Example.test' },
	over: { issuer?: string; audience?: string; expiresIn?: string } = {}
) {
	return new SignJWT(claims)
		.setProtectedHeader({ alg: 'RS256' })
		.setIssuer(over.issuer ?? 'https://acme.cloudflareaccess.com')
		.setAudience(over.audience ?? 'aud-page')
		.setIssuedAt()
		.setExpirationTime(over.expiresIn ?? '5m')
		.sign(privateKey);
}

describe('verifyAccessToken', () => {
	it('returns the lower-cased email of a token from this team and one of its applications', async () => {
		expect(await verifyAccessToken(await token(), config, keys)).toEqual({
			email: 'admin@example.test'
		});
	});

	it('accepts any audience on the list', async () => {
		const both = { team: 'acme', audiences: ['aud-other', 'aud-page'] };
		expect(await verifyAccessToken(await token(), both, keys)).not.toBeNull();
	});

	it('refuses a token for another application, another team, or one that has expired', async () => {
		expect(
			await verifyAccessToken(await token(undefined, { audience: 'aud-else' }), config, keys)
		).toBeNull();
		expect(
			await verifyAccessToken(
				await token(undefined, { issuer: 'https://evil.cloudflareaccess.com' }),
				config,
				keys
			)
		).toBeNull();
		expect(
			await verifyAccessToken(await token(undefined, { expiresIn: '-1m' }), config, keys)
		).toBeNull();
	});

	it('refuses a token signed by a key that is not in the set', async () => {
		const other = await generateKeyPair('RS256');
		const forged = await new SignJWT({ email: 'admin@example.test' })
			.setProtectedHeader({ alg: 'RS256' })
			.setIssuer('https://acme.cloudflareaccess.com')
			.setAudience('aud-page')
			.setExpirationTime('5m')
			.sign(other.privateKey);
		expect(await verifyAccessToken(forged, config, keys)).toBeNull();
	});

	it('refuses a token with no email, no token, garbage, or no configuration', async () => {
		expect(await verifyAccessToken(await token({}), config, keys)).toBeNull();
		expect(await verifyAccessToken(undefined, config, keys)).toBeNull();
		expect(await verifyAccessToken('not.a.jwt', config, keys)).toBeNull();
		expect(await verifyAccessToken(await token(), null, keys)).toBeNull();
	});
});

describe('accessConfigOf', () => {
	it('splits the audience list and needs both a team and an audience', () => {
		expect(accessConfigOf('acme', ' a , b ,')).toEqual({ team: 'acme', audiences: ['a', 'b'] });
		expect(accessConfigOf(undefined, 'a')).toBeNull();
		expect(accessConfigOf('acme', '')).toBeNull();
		expect(accessConfigOf('acme', undefined)).toBeNull();
	});
});
