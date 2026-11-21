// admin pages are audited as a platform admin with the admin API stubbed by page.route, because
// that API needs a Cloudflare Access login the local build cannot supply; each page is audited with
// one row, with none, and while its requests are still pending

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { staticRoutes, type StaticRoute } from './routes';

const WIDTHS = [390, 1280];
const SCHEMES = ['light', 'dark'] as const;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const BLOCKING = ['serious', 'critical'];
const TABBABLE = 10;
const REPORT_DIR = fileURLToPath(new URL('../../test-results/a11y', import.meta.url));

type Scheme = (typeof SCHEMES)[number];
type AdminState = 'rows' | 'empty' | 'loading';

interface Violation {
	id: string;
	impact: string;
	help: string;
	nodes: number;
	targets: string[];
}

function slug(path: string): string {
	return path === '/' ? 'root' : path.slice(1).replace(/\//g, '-');
}

const STAMP = 1_767_225_600_000;

// the answer of each admin GET the pages make on load; an empty one has no rows and zero counts
function adminPayloads(empty: boolean): Record<string, unknown> {
	const rows = <T>(row: T) => ({ items: empty ? [] : [row], nextBefore: null });
	const count = (n: number) => (empty ? 0 : n);
	return {
		'/admin/overview': {
			users: count(3),
			organizations: count(2),
			sites: empty ? {} : { live: 2, creating: 1 },
			operations: empty ? {} : { succeeded: 5, failed: 1 },
			work: { running: count(1), failedLastDay: count(1) },
			abuseOpen: count(1),
			switchesOn: empty ? [] : ['signups.paused'],
			rollout: empty
				? null
				: { releaseId: 'rel_e2e', upgraded: 4, failed: 1, reverted: 0, stuck: 0 }
		},
		'/admin/users': rows({
			id: 'usr_1',
			email: 'person@example.test',
			displayName: 'Person',
			platformRole: null,
			createdAt: STAMP
		}),
		'/admin/organizations': rows({
			id: 'org_1',
			name: 'Example College',
			personal: false,
			createdAt: STAMP
		}),
		'/admin/sites': rows({
			id: 'site_1',
			name: 'Example Site',
			kind: 'drupal',
			state: 'live',
			primaryHostname: 'example.drupflare.app',
			createdAt: STAMP
		}),
		'/admin/operations': rows({
			id: 'op_1',
			type: 'create',
			status: 'succeeded',
			verification: 'passed',
			reason: null,
			createdAt: STAMP
		}),
		'/admin/capacity': {
			generatedAt: STAMP,
			credits: empty
				? { state: 'none' }
				: {
						state: 'ok',
						currency: 'USD',
						balanceCents: 900_000,
						originalCents: 1_000_000,
						usedCents: 100_000,
						daysRemaining: 200,
						validFrom: '2026-01-01',
						validTo: '2027-01-01',
						projectedDepletion: null
					},
			usage: empty
				? { state: 'not_configured' }
				: {
						state: 'ok',
						currency: 'USD',
						from: '2026-11-01',
						through: '2026-11-20',
						totalCents: 12_000,
						services: [{ name: 'Workers', cents: 12_000 }]
					},
			headroom: empty
				? { state: 'not_configured' }
				: {
						state: 'ok',
						kvNamespaces: 40,
						kvLimit: 1000,
						buckets: 6,
						scripts: 20,
						databases: 8,
						rate: { remaining: 900, quota: 1200, resetSeconds: 120, windowSeconds: 300 }
					},
			work: {
				running: count(1),
				failedLastDay: count(1),
				recentFailures: empty
					? []
					: [
							{
								id: 'op_2',
								type: 'update',
								siteId: 'site_1',
								reason: 'timeout',
								at: STAMP
							}
						],
				sites: empty ? {} : { live: 2 }
			}
		},
		'/admin/abuse': rows({
			id: 'abu_1',
			siteId: 'site_1',
			organizationId: 'org_1',
			source: 'report',
			reason: 'Phishing form on the home page',
			state: 'open',
			reviewer: null,
			notes: null,
			createdAt: STAMP,
			updatedAt: STAMP
		}),
		'/admin/flags': {
			flags: empty
				? []
				: [
						{ key: 'signups.paused', value: false, setBy: null, setAt: null },
						{ key: 'notifications.paused', value: false, setBy: null, setAt: null },
						{ key: 'promotion.stopped', value: false, setBy: null, setAt: null },
						{
							key: 'ladder.auto',
							value: true,
							setBy: 'admin@example.test',
							setAt: STAMP
						}
					]
		},
		'/admin/mail': {
			essential: empty ? [] : ['sign-in'],
			optional: empty ? [] : ['digest'],
			notificationsPaused: false,
			today: { sent: count(2), failed: 0, skippedPaused: 0, skippedPreference: count(1) },
			dailyCap: 100
		},
		'/admin/support-grants': {
			grants: empty
				? []
				: [
						{
							id: 'sg_1',
							organizationId: 'org_1',
							grantedBy: 'owner@example.test',
							scope: 'read-metadata',
							reason: 'Investigate a slow import',
							createdAt: STAMP,
							expiresAt: STAMP + 86_400_000,
							revokedAt: null,
							live: true
						}
					],
			breakGlass: empty
				? []
				: [
						{
							id: 'bg_1',
							organizationId: 'org_1',
							admin: 'admin@example.test',
							reason: 'Site down during a launch',
							startedAt: STAMP,
							expiresAt: STAMP + 3_600_000,
							ownersNotified: 1,
							live: false
						}
					]
		},
		'/admin/db/shards': { shards: empty ? [] : [{ shard: 'shard-0', sizeBytes: 4096 }] },
		'/admin/db/queries': {
			items: empty
				? []
				: [
						{
							id: 'q_1',
							name: 'Live sites',
							statement: 'SELECT id FROM sites',
							createdBy: 'admin@example.test',
							createdAt: STAMP
						}
					]
		},
		'/admin/releases': {
			releases: empty
				? []
				: [
						{
							id: 'rel_e2e',
							kind: 'worker',
							version: '1.0.0',
							schemaVersion: 1,
							acceptsSchema: 1,
							publishedAt: STAMP,
							advisoryAt: null,
							rollout: null
						}
					]
		},
		'/admin/ladder': {
			rows: empty
				? []
				: [
						{
							repairId: 'repair.cache-purge',
							source: 'health',
							severity: 'low',
							handle: 'purge-cache',
							automation: 'auto',
							canRunToday: true,
							reason: null
						}
					],
			switches: empty
				? []
				: [{ scope: 'site', scopeId: 'site_1', auto: false, updatedAt: STAMP }]
		},
		'/admin/trust/documents': {
			items: empty
				? []
				: [
						{
							id: 'doc_1',
							title: 'HECVAT 3.0',
							kind: 'hecvat',
							version: '3.0',
							contentType: 'application/pdf',
							sizeBytes: 20_480,
							sha256: 'a'.repeat(64),
							publishedAt: null,
							retiredAt: null
						}
					]
		}
	};
}

// answers every admin GET from the payloads, or holds it for the loading state; the returned list
// fills with any call that has no payload, so a page that starts asking for more fails the audit
async function stubAdminApi(page: Page, state: AdminState): Promise<string[]> {
	const payloads = adminPayloads(state === 'empty');
	const unstubbed: string[] = [];
	await page.route('**/api/v1/admin/**', async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname.replace('/api/v1', '');
		const body = request.method() === 'GET' ? payloads[path] : undefined;
		if (body === undefined) {
			unstubbed.push(`${request.method()} ${path}`);
			await route.fulfill({ status: 404, json: { code: 'not_found', message: 'No stub.' } });
			return;
		}
		if (state === 'loading') return;
		await route.fulfill({ json: body });
	});
	return unstubbed;
}

async function audit(
	page: Page,
	route: StaticRoute,
	width: number,
	scheme: Scheme,
	state: AdminState | null = null
): Promise<void> {
	const unstubbed = state === null ? [] : await stubAdminApi(page, state);
	await page.setViewportSize({ width, height: 900 });
	await page.emulateMedia({ colorScheme: scheme });
	const response = await page.goto(route.path);
	expect(response?.status() ?? 0, `status of ${route.path}`).toBeLessThan(500);
	await expect(page.locator('main#main')).toBeVisible();
	if (state === 'rows' || state === 'empty') {
		await page.waitForLoadState('networkidle');
		await expect(
			page.locator('main#main'),
			`${route.path} settled on its ${state} state`
		).not.toContainText(/Page Not Found|Could Not|Loading/);
	}
	// same-document history changes (the router's first replaceState) also raise framenavigated,
	// so only requests for a new document count as a navigation
	const navigated: string[] = [];
	page.on('request', (request) => {
		if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
			navigated.push(request.url());
		}
	});

	await page.keyboard.press('Tab');
	await expect(
		page.locator('a[href="#main"]').first(),
		`skip link is the first stop on ${route.path}`
	).toBeFocused();

	const unringed: string[] = [];
	for (let stop = 0; stop < TABBABLE; stop += 1) {
		if (stop > 0) await page.keyboard.press('Tab');
		const focus = await page.evaluate(() => {
			const el = document.activeElement as HTMLElement | null;
			if (!el || el === document.body) return null;
			const style = getComputedStyle(el);
			const ring =
				(style.outlineStyle !== 'none' && style.outlineWidth !== '0px') ||
				style.boxShadow !== 'none';
			const label = (el.textContent ?? el.getAttribute('aria-label') ?? '')
				.trim()
				.slice(0, 40);
			return { label: `${el.tagName.toLowerCase()} "${label}"`, ring };
		});
		if (focus && !focus.ring) unringed.push(focus.label);
	}
	expect(unringed, `focus without a visible ring on ${route.path}`).toEqual([]);
	expect(navigated, `main frame navigated after load on ${route.path}`).toEqual([]);
	expect(unstubbed, `admin calls without a stub on ${route.path}`).toEqual([]);

	const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
	const violations: Violation[] = results.violations.map((v) => ({
		id: v.id,
		impact: v.impact ?? 'unknown',
		help: v.help,
		nodes: v.nodes.length,
		targets: v.nodes.map(
			(n) =>
				`${n.target.join(' ')} | ${n.html.slice(0, 160)} | ${(n.failureSummary ?? '').replace(/\s+/g, ' ')}`
		)
	}));
	mkdirSync(REPORT_DIR, { recursive: true });
	writeFileSync(
		`${REPORT_DIR}/${slug(route.path)}-${width}-${scheme}${state && state !== 'rows' ? `-${state}` : ''}.json`,
		JSON.stringify({ route: route.path, width, scheme, state, violations }, null, 2)
	);
	const blocking = violations.filter((v) => BLOCKING.includes(v.impact));
	expect(blocking, `serious or critical axe violations on ${route.path}`).toEqual([]);
}

// the empty and loading states are audited at one width and scheme each, in the pair that is
// hardest on contrast
const OTHER_STATES: { state: AdminState; width: number; scheme: Scheme }[] = [
	{ state: 'empty', width: 390, scheme: 'dark' },
	{ state: 'empty', width: 1280, scheme: 'light' },
	{ state: 'loading', width: 390, scheme: 'dark' },
	{ state: 'loading', width: 1280, scheme: 'light' }
];

for (const route of staticRoutes()) {
	const signedIn = route.layout === 'default';
	const admin = route.path === '/admin' || route.path.startsWith('/admin/');
	if (admin) {
		for (const width of WIDTHS) {
			for (const scheme of SCHEMES) {
				test(`${route.path} at ${width} px, ${scheme}, signed in passes axe and focus checks`, async ({
					adminPage
				}) => {
					await audit(adminPage, route, width, scheme, 'rows');
				});
			}
		}
		for (const { state, width, scheme } of OTHER_STATES) {
			test(`${route.path} at ${width} px, ${scheme}, ${state} state passes axe and focus checks`, async ({
				adminPage
			}) => {
				await audit(adminPage, route, width, scheme, state);
			});
		}
		continue;
	}
	for (const width of WIDTHS) {
		for (const scheme of SCHEMES) {
			const name = `${route.path} at ${width} px, ${scheme}, ${signedIn ? 'signed in' : 'signed out'}`;
			if (signedIn) {
				test(`${name} passes axe and focus checks`, async ({ signedInPage }) => {
					await audit(signedInPage, route, width, scheme);
				});
			} else {
				test(`${name} passes axe and focus checks`, async ({ page }) => {
					await audit(page, route, width, scheme);
				});
			}
		}
	}
}
