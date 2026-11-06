import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../../src/assets/css/main.css', import.meta.url), 'utf8');

const tokens = new Map(
	[...css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map((match) => [
		match[1],
		match[2]
	])
);

// the dark surface Nuxt UI uses in dark mode (neutral-900)
const DARK_SURFACE = '#171717';
const LIGHT_SURFACE = '#ffffff';

function channel(value: number): number {
	const srgb = value / 255;
	return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
	const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
	const first = luminance(a);
	const second = luminance(b);
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function token(name: string): string {
	const value = tokens.get(name);
	if (!value) throw new Error(`missing color token --color-${name}`);
	return value;
}

describe('text on orange and status surfaces', () => {
	it.each([
		['primary solid button, light', 'ink', 'brand-500'],
		['primary solid button, dark', 'ink', 'brand-500'],
		['orange link text, light', 'brand-700', LIGHT_SURFACE],
		['orange link text, dark', 'brand-300', DARK_SURFACE],
		['ok status text, light', 'leaf-700', LIGHT_SURFACE],
		['ok status text, dark', 'leaf-300', DARK_SURFACE]
	])('%s is at least 4.5:1', (_label, textName, background) => {
		const text = textName.startsWith('#') ? textName : token(textName);
		const surface = background.startsWith('#') ? background : token(background);
		expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5);
	});

	it('the primary solid button text is near-black on the brand orange', () => {
		expect(contrastRatio(token('ink'), token('brand-500'))).toBeGreaterThan(7);
	});

	it('white on the brand orange fails, which is why the button text is not white', () => {
		expect(contrastRatio(LIGHT_SURFACE, token('brand-500'))).toBeLessThan(4.5);
	});
});
