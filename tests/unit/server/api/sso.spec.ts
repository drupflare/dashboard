import type { EventHandler } from 'h3';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import callback from '../../../../src/server/api/v1/auth/sso/[orgSlug]/callback.get';
import start from '../../../../src/server/api/v1/auth/sso/[orgSlug]/start.get';
import ssoGet from '../../../../src/server/api/v1/orgs/[orgId]/sso/index.get';
import ssoPut from '../../../../src/server/api/v1/orgs/[orgId]/sso/index.put';
import ssoTest from '../../../../src/server/api/v1/orgs/[orgId]/sso/test.post';
import { LINK_COOKIE } from '../../../../src/server/services/identities';
import { SESSION_COOKIE_NAME } from '../../../../src/server/services/sessions';
import { setSsoServices } from '../../../../src/server/services/sso';
import { isApiHandler, resetApiDeps } from '../../../../src/server/utils/define-api';
import { SSO_STATE_COOKIE, ssoDomainRecord } from '../../../../src/shared/sso';
import { ORG } from '../../domain/fixtures';
import {
	asUser,
	send as sendRequest,
	setup,
	type Reply,
	type Request as RequestInit
} from '../fixtures/harness';
import { useClock } from '../services/auth-support';
import { CLIENT_SECRET, SLUG, body, env, makeRsa, rig, type Rig } from '../services/sso-support';

const R = {
	sso: `/api/v1/orgs/:orgId/sso`,
	test: `/api/v1/orgs/:orgId/sso/test`,
	start: '/api/v1/auth/sso/:orgSlug/start',
	callback: '/api/v1/auth/sso/:orgSlug/callback'
};

const send = (handler: EventHandler, route: string, req: Partial<RequestInit> = {}) =>
	sendRequest(handler, route, { path: route, ...req });

const orgPath = (tail = '') => `/api/v1/orgs/${ORG}/sso${tail}`;

let clock: ReturnType<typeof useClock>;
let r: Rig;

beforeAll(makeRsa);

beforeEach(async () => {
	clock = useClock();
	env.clock = clock;
	r = await rig();
	const proof = ssoDomainRecord(ORG, 'example.edu');
	r.txt.set(proof.name, [`"${proof.value}"`]);
	setSsoServices(r.services);
	setup();
});

afterEach(() => {
	clock.stop();
	setSsoServices(null);
	resetApiDeps();
});

const cookieValue = (reply: Reply, name: string) =>
	reply.headers
		.getSetCookie()
		.find((line) => line.startsWith(`${name}=`))
		?.slice(name.length + 1)
		.split(';')[0];

async function turnOn() {
	const saved = await send(ssoPut, R.sso, {
		method: 'PUT',
		path: orgPath(),
		headers: asUser,
		json: body()
	});
	expect(saved.status).toBe(200);
	const tested = await send(ssoTest, R.test, {
		method: 'POST',
		path: orgPath('/test'),
		headers: asUser
	});
	expect((tested.json as { ok: boolean }).ok).toBe(true);
	const on = await send(ssoPut, R.sso, {
		method: 'PUT',
		path: orgPath(),
		headers: asUser,
		json: body({ clientSecret: undefined, enabled: true })
	});
	expect(on.status).toBe(200);
}

describe('organisation sign-in settings routes', () => {
	it('are api handlers on the manage action', () => {
		for (const handler of [ssoGet, ssoPut, ssoTest, start, callback]) {
			expect(isApiHandler(handler)).toBe(true);
		}
	});

	it('save the settings and show that a secret is set without showing it', async () => {
		const before = await send(ssoGet, R.sso, { path: orgPath(), headers: asUser });
		expect(before.json).toMatchObject({ configured: false, secretSet: false });
		const saved = await send(ssoPut, R.sso, {
			method: 'PUT',
			path: orgPath(),
			headers: asUser,
			json: body()
		});
		expect(saved.status).toBe(200);
		const after = await send(ssoGet, R.sso, { path: orgPath(), headers: asUser });
		expect(after.json).toMatchObject({
			configured: true,
			secretSet: true,
			slug: SLUG,
			redirectUri: `https://app.example.test/api/v1/auth/sso/${SLUG}/callback`
		});
		expect(saved.text + after.text).not.toContain(CLIENT_SECRET);
	});

	it('refuse a member who cannot manage sign-in', async () => {
		setup({ role: 'viewer' });
		const reply = await send(ssoPut, R.sso, {
			method: 'PUT',
			path: orgPath(),
			headers: asUser,
			json: body()
		});
		expect(reply.status).toBe(403);
		expect(r.rows.size).toBe(0);
	});

	it('refuse an owner role in the mapping', async () => {
		const reply = await send(ssoPut, R.sso, {
			method: 'PUT',
			path: orgPath(),
			headers: asUser,
			json: { ...body(), roleMap: [{ group: 'x', role: 'owner' }] }
		});
		expect(reply.status).toBe(400);
	});
});

describe('organisation sign-in browser routes', () => {
	it('start sends the browser to the provider and sets the state cookie', async () => {
		await turnOn();
		const reply = await send(start, R.start, { path: `/api/v1/auth/sso/${SLUG}/start` });
		expect(reply.status).toBe(302);
		expect(reply.headers.get('location')).toContain('/authorize?');
		expect(reply.headers.get('cache-control')).toBe('no-store');
		expect(cookieValue(reply, SSO_STATE_COOKIE)).toBeTruthy();
	});

	it('start sends an unknown name back to the sign-in page', async () => {
		const reply = await send(start, R.start, { path: '/api/v1/auth/sso/nobody-here/start' });
		expect(reply.status).toBe(302);
		expect(reply.headers.get('location')).toBe('/login?sso=unknown');
	});

	async function roundTrip(claims: Record<string, unknown> = {}) {
		await turnOn();
		const started = await send(start, R.start, { path: `/api/v1/auth/sso/${SLUG}/start` });
		const state = cookieValue(started, SSO_STATE_COOKIE) as string;
		const nonce = new URL(started.headers.get('location') as string).searchParams.get('nonce');
		r.idp.idToken = await r.idp.sign({ nonce, ...claims });
		return send(callback, R.callback, {
			path: `/api/v1/auth/sso/${SLUG}/callback?code=abc&state=${state}`,
			headers: { cookie: `${SSO_STATE_COOKIE}=${state}` }
		});
	}

	it('callback signs in, sets the session cookie and goes to the sites page', async () => {
		const reply = await roundTrip();
		expect(reply.status).toBe(302);
		expect(reply.headers.get('location')).toBe('/sites');
		expect(cookieValue(reply, SESSION_COOKIE_NAME)).toBeTruthy();
		expect(cookieValue(reply, SSO_STATE_COOKIE)).toBe('');
	});

	it('callback sends a refused token back to the sign-in page with no session', async () => {
		const reply = await roundTrip({ email_verified: false });
		expect(reply.headers.get('location')).toBe('/login?sso=unverified');
		expect(cookieValue(reply, SESSION_COOKIE_NAME)).toBeUndefined();
	});

	it('callback names a wrong email domain and keeps the reason generic otherwise', async () => {
		const outside = await roundTrip({ email: 'ada@gmail.com' });
		expect(outside.headers.get('location')).toBe('/login?sso=domain');
		const bad = await send(callback, R.callback, {
			path: `/api/v1/auth/sso/${SLUG}/callback?code=abc&state=nope`
		});
		expect(bad.headers.get('location')).toBe('/login?sso=failed');
	});

	it('callback asks an existing account to confirm the link instead of merging', async () => {
		const existing = await r.directory.createUser('ada@example.edu');
		await r.directory.ensurePersonalOrganization(existing);
		const reply = await roundTrip();
		expect(reply.headers.get('location')).toBe(
			'/auth/callback?link=sso&email=ada%40example.edu'
		);
		expect(cookieValue(reply, LINK_COOKIE)).toBeTruthy();
		expect(cookieValue(reply, SESSION_COOKIE_NAME)).toBeUndefined();
	});
});
