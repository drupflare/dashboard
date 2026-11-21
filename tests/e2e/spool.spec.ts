import { expect, test } from './fixtures';

// needs a build with NUXT_PUBLIC_SPOOL=on, spool.json and spool-sw.js in the output; the static
// tier is the one this asserts, so the test is skipped on a plain build
test.skip(process.env.NUXT_PUBLIC_SPOOL !== 'on', 'spool static mode is off in this build');

const pages = ['/docs/changelog', '/docs/security/threat-model'];

test('the second in-page navigation among declared pages makes no origin request', async ({
	page,
	baseURL
}) => {
	const origin = new URL(baseURL ?? 'http://127.0.0.1').origin;
	const requests: string[] = [];
	page.on('request', (request) => {
		if (request.url().startsWith(origin)) requests.push(request.url());
	});

	await page.goto(pages[0]!);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

	await page.locator(`a[href="${pages[1]}"]`).first().click();
	await expect(page).toHaveURL(new RegExp(`${pages[1]}$`));
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

	const before = requests.length;
	await page.locator(`a[href="${pages[0]}"]`).first().click();
	await expect(page).toHaveURL(new RegExp(`${pages[0]}$`));
	await page.waitForTimeout(500);

	expect(requests.slice(before)).toEqual([]);
});
