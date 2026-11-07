import { describe, expect, it } from 'vitest';
import { detach } from '../../../scripts/detach-domain';

function api(service: string | null) {
	const calls: { url: string; method: string }[] = [];
	const call = (async (url: string, init?: RequestInit) => {
		calls.push({ url, method: init?.method ?? 'GET' });
		if ((init?.method ?? 'GET') === 'DELETE') return new Response('{}');
		const result =
			service === null ? [] : [{ id: 'dom1', hostname: 'app.drupflare.com', service }];
		return new Response(JSON.stringify({ result }));
	}) as unknown as typeof fetch;
	return { calls, call };
}

describe('detach', () => {
	it('only reports what it would do without --apply', async () => {
		const { calls, call } = api('drupflare-dashboard-stage');
		const text = await detach(
			'app.drupflare.com',
			'drupflare-dashboard-stage',
			false,
			't',
			call
		);
		expect(text).toContain('would detach');
		expect(calls.map((c) => c.method)).toEqual(['GET']);
	});

	it('deletes the domain when it points at the expected Worker', async () => {
		const { calls, call } = api('drupflare-dashboard-stage');
		await detach('app.drupflare.com', 'drupflare-dashboard-stage', true, 't', call);
		expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
		expect(calls[1]!.url).toMatch(/\/workers\/domains\/dom1$/);
	});

	it('leaves a domain that points at another Worker alone', async () => {
		const { calls, call } = api('drupflare-dashboard');
		await expect(
			detach('app.drupflare.com', 'drupflare-dashboard-stage', true, 't', call)
		).rejects.toThrow('left alone');
		expect(calls.map((c) => c.method)).toEqual(['GET']);
	});

	it('does nothing when no domain is attached', async () => {
		const { calls, call } = api(null);
		expect(await detach('app.drupflare.com', 'x', true, 't', call)).toContain('nothing to do');
		expect(calls).toHaveLength(1);
	});
});
