import { afterEach, describe, expect, it } from 'vitest';
import githubHook from '../../../../../src/server/api/hooks/github.post';
import {
	attachRemote,
	setRepoConnectionDeps
} from '../../../../../src/server/services/repo-connections';
import { ApiError } from '../../../../../src/shared/errors';
import { send } from '../../fixtures/harness';
import { ORG, githubConnection, pushBody, signBody } from '../../services/repo-connections-support';

const HOOK = '/api/hooks/github';

afterEach(() => setRepoConnectionDeps(null));

async function installed() {
	const h = await githubConnection();
	await attachRemote(h.deps, {
		orgId: ORG,
		siteId: 'site_1',
		connectionId: h.connection.id,
		repo: 'ops/site',
		branch: 'main',
		mountPath: 'modules/custom/site'
	});
	setRepoConnectionDeps(h.deps);
	return h;
}

async function deliver(raw: string, headers: Record<string, string | null> = {}, signed = true) {
	const sent: Record<string, string> = {
		'x-github-event': 'push',
		'x-github-delivery': 'delivery-1',
		...(signed ? { 'x-hub-signature-256': await signBody(raw) } : {})
	};
	for (const [name, value] of Object.entries(headers)) {
		if (value === null) delete sent[name];
		else sent[name] = value;
	}
	return send(githubHook, HOOK, { method: 'POST', path: HOOK, raw, headers: sent });
}

describe('POST /api/hooks/github', () => {
	it('answers 501 until the repository services are installed', async () => {
		const reply = await deliver(pushBody(42));
		expect(reply.status).toBe(501);
		expect(reply.json).toMatchObject({ code: 'not_built' });
	});

	it('answers 501 when the app has no webhook secret, and pulls nothing', async () => {
		const h = await installed();
		h.deps.github = null;
		const reply = await deliver(pushBody(42));
		expect(reply.status).toBe(501);
		expect(h.pulls).toEqual([]);
	});

	it('queues a pull for a correctly signed push', async () => {
		const h = await installed();
		const reply = await deliver(pushBody(42));
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({ received: true, duplicate: false, matched: 1 });
		expect(h.pulls).toHaveLength(1);
		expect(h.pulls[0]).toMatch(/:git-pull:[0-9a-f]{64}$/);
		expect([...h.remotes.values()][0]?.lastPullStatus).toBeNull();
	});

	it('refuses a wrong signature with 401 and pulls nothing', async () => {
		const h = await installed();
		const raw = pushBody(42);
		const wrong = await deliver(raw, { 'x-hub-signature-256': 'sha256=00' });
		const tampered = await deliver(raw, {
			'x-hub-signature-256': await signBody(pushBody(7))
		});
		for (const reply of [wrong, tampered]) {
			expect(reply.status).toBe(401);
			expect(reply.json).toMatchObject({ code: 'unauthenticated' });
		}
		expect(h.pulls).toEqual([]);
		expect([...h.remotes.values()][0]?.lastPullStatus).toBeNull();
	});

	it('refuses a missing signature header with 401', async () => {
		const h = await installed();
		const reply = await deliver(pushBody(42), {}, false);
		expect(reply.status).toBe(401);
		expect(h.pulls).toEqual([]);
	});

	it('answers a signed ping with 200, and refuses an unsigned one', async () => {
		const h = await installed();
		const ping = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 });
		const ok = await deliver(ping, { 'x-github-event': 'ping' });
		expect(ok.status).toBe(200);
		expect(ok.json).toEqual({ received: true, duplicate: false, matched: 0 });
		const unsigned = await deliver(ping, { 'x-github-event': 'ping' }, false);
		expect(unsigned.status).toBe(401);
		expect(h.pulls).toEqual([]);
	});

	it('acknowledges a redelivery without pulling again', async () => {
		const h = await installed();
		const raw = pushBody(42);
		await deliver(raw);
		const again = await deliver(raw);
		expect(again.status).toBe(200);
		expect(again.json).toEqual({ received: true, duplicate: true, matched: 0 });
		expect(h.pulls).toHaveLength(1);
		const fresh = await deliver(raw, { 'x-github-delivery': 'delivery-2' });
		expect(fresh.json).toMatchObject({ duplicate: false, matched: 1 });
		expect(h.pulls).toHaveLength(2);
	});

	it('refuses a signed delivery with no delivery id', async () => {
		const h = await installed();
		const reply = await deliver(pushBody(42), { 'x-github-delivery': null });
		expect(reply.status).toBe(400);
		expect(h.pulls).toEqual([]);
	});

	it('ignores a push to another branch and one from another installation', async () => {
		const h = await installed();
		const other = await deliver(pushBody(42, 'refs/heads/dev'), {
			'x-github-delivery': 'delivery-3'
		});
		const stranger = await deliver(pushBody(7), { 'x-github-delivery': 'delivery-4' });
		expect(other.json).toMatchObject({ matched: 0 });
		expect(stranger.json).toMatchObject({ matched: 0 });
		expect(h.pulls).toEqual([]);
	});

	it('still acknowledges a push whose pull failed, and keeps the failure on the remote', async () => {
		const h = await installed();
		h.deps.pullRemote = async () => {
			throw new ApiError('conflict', 'busy', { reason: 'site_busy' });
		};
		const reply = await deliver(pushBody(42));
		expect(reply.status).toBe(200);
		const [remote] = [...h.remotes.values()];
		expect(remote?.lastPullStatus).toBe('failed');
		expect(remote?.lastPullReason).toBe(
			'Another change to this site is still running. Wait for it to finish, then try again.'
		);
	});

	it('refuses a body over the cap before it checks anything', async () => {
		const h = await installed();
		const reply = await deliver('x'.repeat(5 * 1024 * 1024 + 1));
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ code: 'validation' });
		expect(h.pulls).toEqual([]);
	});

	it('does not echo the secret or the signature in any answer', async () => {
		await installed();
		const reply = await deliver(pushBody(42), { 'x-hub-signature-256': 'sha256=00' });
		expect(reply.text).not.toContain('gh-secret');
		expect(reply.text).not.toContain('sha256=');
	});
});
