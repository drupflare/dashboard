import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../../src/assets/css/main.css', import.meta.url), 'utf8');

const tokens = new Map(
	[...css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6}|oklch\([^)]*\));/g)].map((match) => [
		match[1],
		match[2]
	])
);

const LIGHT_SURFACE = '#ffffff';
// Tailwind's red-700 and red-400, the steps main.css binds --ui-error to in light and dark
const RED_700 = 'oklch(0.505 0.213 27.518)';
const RED_400 = 'oklch(0.704 0.191 22.216)';

function channel(value: number): number {
	const srgb = value / 255;
	return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function clamp(value: number): number {
	return Math.min(1, Math.max(0, value));
}

// linear sRGB channels of a colour from a hex string or an oklch() string; out-of-gamut values are clipped
function linearRgb(color: string): number[] {
	if (color.startsWith('#'))
		return [1, 3, 5].map((i) => channel(parseInt(color.slice(i, i + 2), 16)));
	const [l = 0, c = 0, hue = 0] = color.slice(6, -1).split(' ').map(Number);
	const a = c * Math.cos((hue * Math.PI) / 180);
	const b = c * Math.sin((hue * Math.PI) / 180);
	const [L = 0, M = 0, S = 0] = [
		l + 0.3963377774 * a + 0.2158037573 * b,
		l - 0.1055613458 * a - 0.0638541728 * b,
		l - 0.0894841775 * a - 1.291485548 * b
	].map((value) => value ** 3);
	return [
		4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
		-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
		-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S
	].map(clamp);
}

function luminance(color: string): number {
	const [r = 0, g = 0, b = 0] = linearRgb(color);
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

// the block of main.css that sets one selector's custom properties
function block(selector: string): string {
	const start = css.indexOf(`${selector} {`);
	if (start < 0) throw new Error(`missing ${selector} block`);
	return css.slice(start, css.indexOf('}', start));
}

// the colour a --ui-* role resolves to in a block, through the palette step main.css binds it to
function role(scope: string, name: string): string {
	const match = new RegExp(`--ui-${name}:\\s*var\\(--color-([a-z0-9-]+)\\)`).exec(scope);
	if (!match?.[1]) throw new Error(`missing --ui-${name}`);
	return token(match[1]);
}

const ROOT = block(':root');
const DARK = block('.dark');
const DARK_SURFACE = role(DARK, 'bg');
const DARK_ELEVATED = role(DARK, 'bg-elevated');

describe('colour pairs the app sets, against WCAG 2.2 AA', () => {
	it.each([
		// text, 4.5:1
		['primary solid button, light and dark', token('ink'), token('brand-500'), 4.5],
		['orange link text, light', token('brand-700'), LIGHT_SURFACE, 4.5],
		['orange link text, dark', token('brand-300'), DARK_SURFACE, 4.5],
		['error text, light', RED_700, LIGHT_SURFACE, 4.5],
		['error text, dark', RED_400, DARK_SURFACE, 4.5],
		['solid error button text, light', LIGHT_SURFACE, RED_700, 4.5],
		['ok status text, light', token('leaf-700'), LIGHT_SURFACE, 4.5],
		['ok status text, dark', token('leaf-300'), DARK_SURFACE, 4.5],
		['muted text, light', role(ROOT, 'text-muted'), LIGHT_SURFACE, 4.5],
		['dimmed text, light', role(ROOT, 'text-dimmed'), LIGHT_SURFACE, 4.5],
		['text, dark', role(DARK, 'text'), DARK_SURFACE, 4.5],
		['muted text, dark', role(DARK, 'text-muted'), DARK_SURFACE, 4.5],
		['dimmed text, dark', role(DARK, 'text-dimmed'), DARK_SURFACE, 4.5],
		['text on an elevated surface, dark', role(DARK, 'text'), DARK_ELEVATED, 4.5],
		['muted text on an elevated surface, dark', role(DARK, 'text-muted'), DARK_ELEVATED, 4.5],
		['dimmed text on an elevated surface, dark', role(DARK, 'text-dimmed'), DARK_ELEVATED, 4.5],
		// focus indicators and input boundaries, 3:1 (WCAG 1.4.11)
		['focus ring, light', role(ROOT, 'focus'), LIGHT_SURFACE, 3],
		['focus ring, dark', role(DARK, 'focus'), DARK_SURFACE, 3],
		['input border, light', role(ROOT, 'border-accented'), LIGHT_SURFACE, 3],
		['input border, dark', role(DARK, 'border-accented'), DARK_SURFACE, 3]
	])('%s is at least %s:1', (_label, foreground, background, minimum) => {
		expect(
			contrastRatio(foreground, background),
			`${foreground} on ${background}`
		).toBeGreaterThanOrEqual(minimum);
	});

	it('binds the error role to the red steps the pairs above measure', () => {
		expect(ROOT).toContain('--ui-error: var(--color-red-700)');
		expect(DARK).toContain('--ui-error: var(--color-red-400)');
	});

	it('the primary solid button text is near-black on the brand orange', () => {
		expect(contrastRatio(token('ink'), token('brand-500'))).toBeGreaterThan(7);
	});

	it('white on the brand orange fails, which is why the button text is not white', () => {
		expect(contrastRatio(LIGHT_SURFACE, token('brand-500'))).toBeLessThan(4.5);
	});
});
