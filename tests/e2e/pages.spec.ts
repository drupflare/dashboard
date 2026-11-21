import type { Page } from '@playwright/test';
import { ERROR_STATUS } from '../../src/shared/errors';
import { expect, observe, test, type Observed } from './fixtures';
import { staticRoutes } from './routes';

const RAW_CODES = new RegExp(
	`\\b(${Object.keys(ERROR_STATUS)
		.filter((code) => code.includes('_'))
		.join('|')})\\b`
);

const phoneWidth = 390;

for (const { path: route } of staticRoutes()) {
	test(`${route} renders signed in at ${phoneWidth} px`, async ({ signedInPage, baseURL }) => {
		await signedInPage.setViewportSize({ width: phoneWidth, height: 844 });
		const seen = observe(signedInPage, baseURL);
		const response = await signedInPage.goto(route);
		expect(response?.status() ?? 0, `status of ${route}`).toBeLessThan(500);
		await expect(signedInPage.getByRole('main')).toBeVisible();
		const overflow = await signedInPage.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow, `horizontal overflow on ${route}`).toBeLessThanOrEqual(0);
		const text = await signedInPage.locator('main').innerText();
		expect(text.match(RAW_CODES)?.[0] ?? null, `raw error code on ${route}`).toBeNull();
		expect(seen.consoleErrors, `console errors on ${route}`).toEqual([]);
		expect(seen.failed, `failed same-origin requests on ${route}`).toEqual([]);
	});
}

// the server renders these pages with no organization and no session user, so a page or the side
// navigation that reads either store on the first paint hydrates into a different tree
const HYDRATION_ROUTES = [
	'/org/budget',
	'/org/usage',
	'/org/cost-centers',
	'/org/pilots',
	'/org/members',
	'/sites'
];
const ADMIN_HYDRATION_ROUTES = ['/admin', '/admin/abuse', '/admin/flags'];

const hydrationMessages = (seen: Observed) =>
	seen.consoleErrors.filter((text) => /hydrat/i.test(text));

async function stubOrganization(page: Page) {
	await page.route('**/api/v1/me/organizations', (route) =>
		route.fulfill({
			json: {
				items: [{ id: 'org_e2e', name: 'E2E College', personal: false, role: 'owner' }],
				nextCursor: null
			}
		})
	);
	await page.route('**/api/v1/orgs/org_e2e/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/entitlement')) {
			return route.fulfill({ json: { planId: 'free', managedPlanId: 'free', features: {} } });
		}
		if (path.endsWith('/budget')) return route.fulfill({ json: { status: 'not_applicable' } });
		return route.fulfill({ status: 404, json: { code: 'not_found', message: 'No stub.' } });
	});
}

for (const route of HYDRATION_ROUTES) {
	test(`${route} hydrates without mismatches with an organization`, async ({
		signedInPage,
		baseURL
	}) => {
		const seen = observe(signedInPage, baseURL);
		await stubOrganization(signedInPage);
		await signedInPage.goto(route);
		await expect(signedInPage.getByRole('main')).toBeVisible();
		await signedInPage.waitForLoadState('networkidle');
		expect(hydrationMessages(seen), `hydration on ${route}`).toEqual([]);
	});
}

for (const route of ADMIN_HYDRATION_ROUTES) {
	test(`${route} hydrates without mismatches as a platform admin`, async ({
		adminPage,
		baseURL
	}) => {
		const seen = observe(adminPage, baseURL);
		await adminPage.route('**/api/v1/admin/**', (r) =>
			r.fulfill({ status: 404, json: { code: 'not_found', message: 'No stub.' } })
		);
		await adminPage.goto(route);
		await expect(adminPage.getByRole('main')).toBeVisible();
		await adminPage.waitForLoadState('networkidle');
		expect(hydrationMessages(seen), `hydration on ${route}`).toEqual([]);
	});
}
