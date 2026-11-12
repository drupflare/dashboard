import { afterEach, describe, expect, it, vi } from 'vitest';
import probe from '../../../../src/server/api/v1/orgs/[orgId]/planes/cloudflare/probe.post';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { DEPT, facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asKey, asUser, send, setup } from '../fixtures/harness';

const ROUTE = '/api/v1/orgs/:orgId/planes/cloudflare/probe';
const TOKEN = 'user-token-value-0123456789';
const ACCOUNT = 'a'.repeat(32);

const path = (orgId: string = ORG) => `/api/v1/orgs/${orgId}/planes/cloudflare/probe`;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// the account list answers, and every capability read is refused, so the report has six rows
function stubCloudflare(): void {
	vi.stubGlobal('fetch', async (input: string) => {
		const { pathname } = new URL(String(input));
		if (pathname === '/client/v4/user/tokens/verify') {
			return json({ success: true, result: { id: 'tok_1', status: 'active' } });
		}
		if (pathname === '/client/v4/accounts') {
			return json({ success: true, result: [{ id: ACCOUNT, name: 'Campus Site' }] });
		}
		return json({ success: false }, 403);
	});
}

const call = (json: unknown, headers: Record<string, string> = asUser, orgId: string = ORG) =>
	send(probe, ROUTE, { method: 'POST', path: path(orgId), headers, json });

afterEach(() => {
	resetApiDeps();
	vi.unstubAllGlobals();
});

describe('POST /api/v1/orgs/:orgId/planes/cloudflare/probe', () => {
	it('answers 401 without a session', async () => {
		setup();
		expect((await call({ token: TOKEN }, {})).status).toBe(401);
	});

	it('refuses an API key even when the key holds the scope, and never reaches Cloudflare', async () => {
		const reach = vi.fn(async () => json({ success: false }, 500));
		vi.stubGlobal('fetch', reach);
		setup({
			facts: (input) => ({
				...facts({ ...member('owner'), ...fresh }),
				...(input.principal.kind === 'key'
					? { key: { id: 'key-1', scopes: ['plane.connect'] } }
					: {})
			})
		});
		const reply = await call({ token: TOKEN }, asKey);
		expect(reply.status).toBe(403);
		expect(reach).not.toHaveBeenCalled();
	});

	it('refuses a member who cannot connect a site plane', async () => {
		setup({ role: 'viewer' });
		expect((await call({ token: TOKEN })).status).toBe(403);
	});

	it('answers 404 when the loaded organisation is not the one in the path', async () => {
		setup({
			deps: {
				load: async () => ({
					resource: { orgId: ORG, departmentId: DEPT },
					facts: facts({ ...member('owner'), ...fresh })
				})
			}
		});
		expect((await call({ token: TOKEN }, asUser, OTHER_ORG)).status).toBe(404);
	});

	it('rejects a body without a token', async () => {
		setup();
		const reply = await call({});
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ code: 'validation' });
	});

	it('rejects a field the body does not allow', async () => {
		setup();
		expect((await call({ token: TOKEN, endpoint: 'https://example.com' })).status).toBe(400);
	});

	it('answers 422 for an account the token cannot see', async () => {
		stubCloudflare();
		setup();
		const reply = await call({ token: TOKEN, accountId: 'c'.repeat(32) });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ code: 'unprocessable' });
	});

	it('returns the report and never the token', async () => {
		stubCloudflare();
		setup();
		const reply = await call({ token: TOKEN });
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			status: 'active',
			kind: 'user',
			tokenId: 'tok_1',
			account: { id: ACCOUNT, name: 'Campus Site' },
			canDownscope: false
		});
		expect((reply.json as { capabilities: unknown[] }).capabilities).toHaveLength(6);
		expect(reply.headers.get('cache-control')).toBe('no-store');
		expect(JSON.stringify(reply.json)).not.toContain(TOKEN);
	});
});
