import type { Locator, Page } from '@playwright/test';
import { expect, observe, test } from './fixtures';

const MAX_TABS = 60;

// presses Tab until the locator's element has focus; fails with the count if it never does
async function tabTo(page: Page, target: Locator): Promise<void> {
	for (let presses = 0; presses < MAX_TABS; presses += 1) {
		if (await target.evaluate((el) => el === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	throw new Error(`focus never reached the target after ${MAX_TABS} Tab presses`);
}

// a focus ring is an outline or a box shadow; a bare focused control counts as invisible
async function hasFocusRing(target: Locator): Promise<boolean> {
	return target.evaluate((el) => {
		const style = getComputedStyle(el);
		return (
			(style.outlineStyle !== 'none' && style.outlineWidth !== '0px') ||
			style.boxShadow !== 'none'
		);
	});
}

test('login is reachable and operable by keyboard, with no focus trap', async ({
	page,
	baseURL
}) => {
	const seen = observe(page, baseURL);
	await page.goto('/login');
	const email = page.locator('input[type="email"]').first();
	await expect(email).toBeVisible();

	await tabTo(page, email);
	expect(await hasFocusRing(email), 'focus ring on the email field').toBe(true);

	// A trap keeps focus inside the page for ever. Focus that reaches BODY has left the page for
	// the browser UI, and focus that returns to the first stop has cycled, so either passes.
	const sequence: string[] = [];
	for (let presses = 0; presses < 30; presses += 1) {
		await page.keyboard.press('Tab');
		sequence.push(
			await page.evaluate(() => {
				const el = document.activeElement;
				if (el === null || el === document.body) return 'BODY';
				return `${el.tagName}:${el.textContent?.trim().slice(0, 40)}`;
			})
		);
	}
	const left = sequence.includes('BODY');
	const cycled = sequence.indexOf(sequence[0] ?? '', 1) > 0;
	expect(left || cycled, `focus never left the page: ${sequence.join(' > ')}`).toBe(true);
	expect(new Set(sequence).size, 'focus cycles through more than one control').toBeGreaterThan(2);
	expect(seen.consoleErrors).toEqual([]);
});

test('new site flow is reachable and operable by keyboard', async ({ signedInPage, baseURL }) => {
	const seen = observe(signedInPage, baseURL);
	await signedInPage.goto('/new');
	const skip = signedInPage.getByRole('button', { name: 'Skip' });
	await expect(skip).toBeVisible();

	await tabTo(signedInPage, skip);
	expect(await hasFocusRing(skip), 'focus ring on Skip').toBe(true);

	await signedInPage.keyboard.press('Enter');
	await expect(signedInPage.getByRole('button', { name: 'Create' })).toBeVisible();
	expect(seen.consoleErrors).toEqual([]);
});
