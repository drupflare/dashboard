import { describe, expect, it } from 'vitest';
import { fromBase64Url, signingKeyFromSeed } from '../../../contracts/src/common';
import { generateSecrets, plan, withRetry } from '../../../scripts/provision-secrets';

describe('generateSecrets', () => {
	it('derives each public key from its seed and never repeats a value', async () => {
		const secrets = await generateSecrets();
		expect((await signingKeyFromSeed(fromBase64Url(secrets.SITE_AUTH_SEED!))).publicKey).toBe(
			secrets.LEASE_PUBLIC_KEY
		);
		expect((await signingKeyFromSeed(fromBase64Url(secrets.CONTROL_SEED!))).publicKey).toBe(
			secrets.CONTROL_PUBLIC_KEY
		);
		const values = Object.values(secrets);
		expect(new Set(values).size).toBe(values.length);
		expect(await generateSecrets()).not.toEqual(secrets);
	});
});

describe('withRetry', () => {
	it('repeats a failing attempt up to the limit and stops at the first success', async () => {
		const results = [{ code: 1 }, { code: 1 }, { code: 0 }, { code: 0 }];
		let calls = 0;
		const pauses: number[] = [];
		const last = await withRetry(
			async () => results[calls++]!,
			(r) => r.code === 0,
			5,
			async (ms) => void pauses.push(ms)
		);
		expect(last.code).toBe(0);
		expect(calls).toBe(3);
		expect(pauses).toHaveLength(2);
	});

	it('returns the last failure when every attempt fails', async () => {
		let calls = 0;
		const last = await withRetry(
			async () => ({ code: ++calls }),
			() => false,
			3,
			async () => {}
		);
		expect(last.code).toBe(3);
	});
});

describe('plan', () => {
	const values = {
		SITE_AUTH_SEED: 'a',
		LEASE_PUBLIC_KEY: 'b',
		CONTROL_SEED: 'c',
		CONTROL_PUBLIC_KEY: 'd',
		START_SECRET: 'e',
		KEK_V1: 'f',
		AUTH_CODE_SECRET: 'g',
		CF_API_TOKEN: 't',
		CF_ACCOUNT_ID: 'x'
	};

	it('sets only the deploy credentials for staging, whose Workers keep their secrets', () => {
		expect(plan('staging', values).map((a) => [a.kind, a.name])).toEqual([
			['github', 'CLOUDFLARE_API_TOKEN'],
			['github', 'CLOUDFLARE_ACCOUNT_ID']
		]);
	});

	it('gives the engine and the dashboard the same start secret and key encryption key', () => {
		const actions = plan('production', values);
		const of = (worker: string, name: string) =>
			actions.find((a) => a.kind === 'worker' && a.worker === worker && a.name === name)
				?.value;
		expect(of('drupflare-engine', 'START_SECRET')).toBe(
			of('drupflare-dashboard', 'START_SECRET')
		);
		expect(of('drupflare-engine', 'KEK_V1')).toBe(of('drupflare-dashboard', 'KEK_V1'));
		expect(of('drupflare-dispatch', 'CONTROL_PUBLIC_KEY')).toBe('d');
	});

	it('sets the preview keys and deploy credentials on GitHub only, never on a Worker', () => {
		const actions = plan('preview', { ...values, NUXT_TURNSTILE_SECRET_KEY: 'k' });
		expect(actions.every((a) => a.kind === 'github' && a.environment === 'preview')).toBe(true);
		expect(actions.map((a) => a.name).sort()).toEqual([
			'AUTH_CODE_SECRET',
			'CLOUDFLARE_ACCOUNT_ID',
			'CLOUDFLARE_API_TOKEN',
			'KEK_V1',
			'NUXT_TURNSTILE_SECRET_KEY',
			'START_SECRET'
		]);
	});

	it('adds a provider secret only when it was supplied', () => {
		const names = (extra: Record<string, string>) =>
			plan('production', { ...values, ...extra })
				.filter((a) => a.kind === 'worker' && a.worker === 'drupflare-dashboard')
				.map((a) => a.name);
		expect(names({})).not.toContain('NUXT_GITHUB_CLIENT_SECRET');
		expect(names({ NUXT_GITHUB_CLIENT_SECRET: 'z' })).toContain('NUXT_GITHUB_CLIENT_SECRET');
	});
});
