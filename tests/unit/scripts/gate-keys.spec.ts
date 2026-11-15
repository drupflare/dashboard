import { describe, expect, it } from 'vitest';
import { fromBase64Url, publicKeySchema, signingKeyFromSeed } from '../../../contracts/src/common';
import { generateGateKeys, run } from '../../../scripts/gate-keys';

describe('gate-keys', () => {
	it('makes a public key that matches the private seed', async () => {
		const keys = await generateGateKeys();
		expect(publicKeySchema.safeParse(keys.publicKey).success).toBe(true);
		const seed = fromBase64Url(keys.privateKey);
		expect(seed).toHaveLength(32);
		expect((await signingKeyFromSeed(seed)).publicKey).toBe(keys.publicKey);
	});

	it('prints only the public key and writes the private key to the file', async () => {
		const written: [string, string][] = [];
		const result = await run(['--out', '/tmp/gate.key'], (path, data) => {
			written.push([path, data]);
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
		expect(written).toHaveLength(1);
		expect(written[0]![0]).toBe('/tmp/gate.key');
		const secret = written[0]![1].trim();
		expect(result.stdout).not.toContain(secret);
		expect(result.stderr).not.toContain(secret);
		expect((await signingKeyFromSeed(fromBase64Url(secret))).publicKey).toBe(
			result.stdout.trim()
		);
	});

	it('makes a different pair each time', async () => {
		const a = await generateGateKeys();
		const b = await generateGateKeys();
		expect(a.publicKey).not.toBe(b.publicKey);
	});

	it('refuses to run without a file or with an unknown flag, writing nothing', async () => {
		const write = () => {
			throw new Error('should not write');
		};
		expect((await run([], write)).code).toBe(2);
		expect((await run(['--bogus'], write)).code).toBe(2);
	});

	it('reports a file it cannot write and prints no key', async () => {
		const result = await run(['--out', '/exists'], () => {
			throw new Error('EEXIST');
		});
		expect(result.code).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('/exists');
	});
});
