import { expect, observe, test } from './fixtures';

const pages = [
	{ path: '/', title: 'Drupflare: Managed Drupal Sites on Cloudflare' },
	{ path: '/login', title: 'Sign In' },
	{ path: '/migrate', title: 'Move a Drupal Site to Drupflare' },
	{ path: '/migrate/preflight', title: 'Check a Site Address' },
	{ path: '/docs', title: undefined }
];

// a prerender rule with no prerendered page makes every docs link request a payload that does not exist
test('/docs links request no payload that answers an error', async ({ page, baseURL }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	const seen = observe(page, baseURL);
	await page.goto('/docs');
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(500);
	expect(seen.failed).toEqual([]);
});

test('the docs mirror refuses a slug that climbs out of the tree', async ({ request }) => {
	for (const id of ['worker', 'spool']) {
		const response = await request.get(`/docs/${id}/_page?slug=..%2F..%2Fetc%2Fpasswd`);
		expect(response.status()).toBe(404);
	}
});

// reads the repositories on github.com through the raw fallback, so it runs only when asked
test.describe('docs mirrors against GitHub', () => {
	test.skip(process.env.E2E_NETWORK !== '1', 'set E2E_NETWORK=1 to read github.com');
	for (const id of ['worker', 'spool']) {
		for (const path of [`/docs/${id}`, `/docs/${id}/getting-started`]) {
			test(`${path} renders with the mirror banner`, async ({ page, baseURL }) => {
				const seen = observe(page, baseURL);
				const response = await page.goto(path);
				expect(response?.status(), `status of ${path}`).toBe(200);
				await expect(page.getByRole('note').first()).toContainText('This is a mirror of');
				await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
				await expect(page.locator('h1')).toHaveCount(1);
				expect(seen.consoleErrors, `console errors on ${path}`).toEqual([]);
				expect(seen.failed, `failed same-origin requests on ${path}`).toEqual([]);
			});
		}
	}
});

for (const { path, title } of pages) {
	test(`${path} renders signed out`, async ({ page, baseURL }) => {
		const seen = observe(page, baseURL);
		const response = await page.goto(path);
		expect(response?.status(), `status of ${path}`).toBeLessThan(400);
		await expect(page.locator('h1')).toHaveCount(1);
		if (title !== undefined) await expect(page).toHaveTitle(title);
		expect(seen.consoleErrors, `console errors on ${path}`).toEqual([]);
		expect(seen.failed, `failed same-origin requests on ${path}`).toEqual([]);
	});
}
