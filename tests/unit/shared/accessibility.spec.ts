import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

const vueFiles = (readdirSync(new URL('src/', ROOT), { recursive: true }) as string[])
	.filter((name) => name.endsWith('.vue'))
	.map((name) => ({ name: `src/${name}`, source: read(`src/${name}`) }));

// attribute values may hold a '>' (v-if="a > b"), so attributes are matched quote by quote
const BUTTON = /<(UButton|button)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>)/g;

function unnamedIconButtons(source: string): number {
	const template = source.includes('<template>')
		? source.slice(source.indexOf('<template>'))
		: source;
	let count = 0;
	for (const match of template.matchAll(BUTTON)) {
		const attrs = match[2] ?? '';
		if (!/(?:^|\s):?icon=/.test(attrs)) continue;
		if (/(?:^|\s):?(aria-label|aria-labelledby|label)=/.test(attrs)) continue;
		const rest = template.slice((match.index ?? 0) + match[0].length);
		const closing = new RegExp(`</${match[1]}\\s*>`).exec(rest);
		const inner = match[3] === '>' && closing ? rest.slice(0, closing.index) : '';
		const visible = inner
			.replace(/<[^>]*>/g, '')
			.replace(/\{\{[\s\S]*?\}\}/g, 'x')
			.trim();
		if (visible === '') count += 1;
	}
	return count;
}

describe('accessibility in the source', () => {
	it('the document declares its language', () => {
		expect(read('nuxt.config.ts')).toMatch(/htmlAttrs:\s*\{\s*lang:\s*'en'\s*\}/);
	});

	it('the sign-in layout has a skip link to its main landmark', () => {
		const layout = read('src/layouts/auth.vue');
		expect(layout).toContain('href="#main"');
		expect(layout).toContain('id="main"');
	});

	it.each(['auth', 'default', 'public'])(
		'the %s layout shows its skip link in the flow, not over the header links',
		(name) => {
			const layout = read(`src/layouts/${name}.vue`);
			const link = /<a\s+href="#main"\s+class="([^"]*)"/.exec(layout)?.[1] ?? '';
			expect(link).toContain('focus:not-sr-only');
			expect(link).toContain('focus:block');
			expect(link).not.toContain('focus:absolute');
		}
	);

	it('no text link takes its colour from the primary role, which is 2.6:1 on white', () => {
		const links = vueFiles
			.filter((file) =>
				/<(a|NuxtLink)\b[^>]*class="[^"]*(?<![:-])\btext-primary\b/.test(file.source)
			)
			.map((file) => file.name);
		expect(links).toEqual([]);
	});

	it('every table that scrolls sideways sits in a labelled region a keyboard can focus', () => {
		const WRAPPER = /<div\b((?:[^>"']|"[^"]*"|'[^']*')*)>\s*<table\b/g;
		const bare = vueFiles
			.filter((file) =>
				[...file.source.matchAll(WRAPPER)].some((match) => {
					const attrs = match[1] ?? '';
					return (
						attrs.includes('overflow-x-auto') &&
						!(
							/\btabindex="0"/.test(attrs) &&
							/\brole="region"/.test(attrs) &&
							/\baria-label=/.test(attrs)
						)
					);
				})
			)
			.map((file) => file.name);
		expect(bare).toEqual([]);
	});

	it('the repository filter has an accessible name, not only a placeholder', () => {
		expect(read('src/pages/repos/index.vue')).toMatch(
			/v-model="repoFilter"[\s\S]*?aria-label="Filter by repository name"/
		);
	});

	it('the site config select and textarea are named after their setting', () => {
		const field = read('src/components/site/config/Field.vue');
		expect(field.match(/:aria-label="field\.label"/g)).toHaveLength(3);
	});

	it('every icon-only button has a name', () => {
		const unnamed = vueFiles
			.filter((file) => unnamedIconButtons(file.source) > 0)
			.map((file) => file.name);
		expect(unnamed).toEqual([]);
	});

	it('every table declares header cells', () => {
		const bare = vueFiles
			.filter((file) => /<table\b/.test(file.source) && !/<th\b/.test(file.source))
			.map((file) => file.name);
		expect(bare).toEqual([]);
	});

	it('every chart that draws bars also renders its table fallback', () => {
		const bare = vueFiles
			.filter(
				(file) => /<ChartUsage\b/.test(file.source) && !/<ChartTable\b/.test(file.source)
			)
			.map((file) => file.name);
		expect(bare).toEqual([]);
	});
});
