import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import { test as base, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { getPlatformProxy } from 'wrangler';
import {
	createSession,
	SESSION_COOKIE_NAME,
	type KvStore
} from '../../src/server/services/sessions';
import { SESSION_HINT_COOKIE } from '../../src/shared/session-hint';

// The local build's persisted state. wrangler dev writes here for .output/server/wrangler.json,
// so a session seeded from this process is read by the server under test. No Cloudflare call.
const STATE_DIR = '.output/server/.wrangler/state/v3';
const CONFIG = '.output/server/wrangler.json';
const FIXTURE_USER = {
	id: 'usr_e2e_local',
	email: 'e2e-local@example.test'
};

const ADMIN_USER = {
	id: 'usr_e2e_admin',
	email: 'e2e-admin@example.test'
};

// the admin pages ask for a fresh step-up; a stamp a day ahead keeps one for a whole run
const STEP_UP_AHEAD_MS = 24 * 60 * 60 * 1000;

interface LocalBindings {
	KV: KVNamespace;
	DB: D1Database;
}

// Writes a user row and a session into the local build's state. The token is returned to the
// caller only; nothing here logs it. The admin user holds the platform role and a fresh step-up;
// the admin API itself still needs Cloudflare Access, so specs stub it with page.route.
async function seedSession(admin = false): Promise<string> {
	const user = admin ? ADMIN_USER : FIXTURE_USER;
	const proxy = await getPlatformProxy<LocalBindings>({
		configPath: CONFIG,
		persist: { path: STATE_DIR },
		remoteBindings: false
	});
	try {
		const now = Date.now();
		await proxy.env.DB.prepare(
			'INSERT OR IGNORE INTO users (id, email, display_name, platform_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
		)
			.bind(user.id, user.email, 'E2E Local', admin ? 'admin' : null, now, now)
			.run();
		const issued = await createSession(proxy.env.KV as unknown as KvStore, {
			userId: user.id,
			userAgent: 'playwright',
			...(admin ? { stepUpAt: now + STEP_UP_AHEAD_MS } : {})
		});
		return issued.token;
	} finally {
		await proxy.dispose();
	}
}

type Fixtures = {
	signedInContext: BrowserContext;
	signedInPage: Page;
	adminContext: BrowserContext;
	adminPage: Page;
};

type WorkerFixtures = {
	sessionToken: string;
	adminSessionToken: string;
};

// a __Host- cookie cannot carry the domain attribute that addCookies derives from a url, so the
// cookie header is sent on every request of the context instead
function contextFor(browser: Browser, baseURL: string | undefined, token: string) {
	return browser.newContext({
		baseURL,
		extraHTTPHeaders: {
			cookie: `${SESSION_COOKIE_NAME}=${token}; ${SESSION_HINT_COOKIE}=1`
		}
	});
}

export const test = base.extend<Fixtures, WorkerFixtures>({
	sessionToken: [
		async ({}, use) => {
			await use(await seedSession());
		},
		{ scope: 'worker' }
	],
	adminSessionToken: [
		async ({}, use) => {
			await use(await seedSession(true));
		},
		{ scope: 'worker' }
	],
	signedInContext: async ({ browser, baseURL, sessionToken }, use) => {
		const context = await contextFor(browser, baseURL, sessionToken);
		await use(context);
		await context.close();
	},
	signedInPage: async ({ signedInContext }, use) => {
		const page = await signedInContext.newPage();
		await use(page);
	},
	adminContext: async ({ browser, baseURL, adminSessionToken }, use) => {
		const context = await contextFor(browser, baseURL, adminSessionToken);
		await use(context);
		await context.close();
	},
	adminPage: async ({ adminContext }, use) => {
		const page = await adminContext.newPage();
		await use(page);
	}
});

export { expect } from '@playwright/test';

export interface Observed {
	consoleErrors: string[];
	failed: string[];
}

// collects the console errors and hydration messages, page errors and same-origin requests that failed for one page; the
// 401 the signed-out session check answers is expected, so it is not reported as a console error
export function observe(page: Page, baseURL: string | undefined): Observed {
	const origin = new URL(baseURL ?? 'http://127.0.0.1').origin;
	const same = (url: string) => new URL(url).origin === origin;
	const seen: Observed = { consoleErrors: [], failed: [] };
	let expectedUnauthorized = 0;
	page.on('console', (message) => {
		// a hydration mismatch is a console warning in some Vue builds, so the type filter skips it
		if (message.type() !== 'error' && !/hydrat/i.test(message.text())) return;
		if (message.text().includes('status of 401') && expectedUnauthorized > 0) {
			expectedUnauthorized -= 1;
			return;
		}
		seen.consoleErrors.push(message.text());
	});
	page.on('pageerror', (error) => seen.consoleErrors.push(error.message));
	page.on('response', (response) => {
		if (response.status() === 401 && new URL(response.url()).pathname === '/api/v1/me') {
			expectedUnauthorized += 1;
			return;
		}
		if (response.status() >= 400 && same(response.url())) {
			seen.failed.push(`${response.status()} ${response.url()}`);
		}
	});
	page.on('requestfailed', (request) => {
		if (same(request.url())) seen.failed.push(`failed ${request.url()}`);
	});
	return seen;
}
