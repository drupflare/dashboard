import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDocsAdminPath } from '../src/shared/docs';

export interface BuiltFile {
	path: string;
	bytes: Uint8Array;
}

export interface SpoolRoute {
	pattern: string;
	strategy: 'static';
	version: string;
	freshness?: { maxStale: number; mode: 'soft' };
}

export interface SpoolManifest {
	schema: 1;
	routes: SpoolRoute[];
}

// the only public pages a device may keep: docs (never admin), the trust page and a demo page
export function isDeclaredPage(route: string): boolean {
	if (route === '/trust' || route === '/demo') return true;
	return (route === '/docs' || route.startsWith('/docs/')) && !isDocsAdminPath(route);
}

// output-relative html file to the route it answers: docs/a/index.html is /docs/a
export function routeOfHtml(path: string): string | null {
	const page = path.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '');
	const route = `/${page}`.replace(/\/$/, '') || '/';
	return isDeclaredPage(route) ? route : null;
}

export function digest(bytes: Uint8Array, algorithm: 'sha256' | 'sha384'): string {
	const hash = createHash(algorithm).update(bytes).digest('base64');
	return `${algorithm}-${hash}`;
}

// one route per declared page and per /_nuxt asset, plus the page runtime at /client.js
export function buildSpoolManifest(files: readonly BuiltFile[]): SpoolManifest {
	const routes: SpoolRoute[] = [];
	for (const file of files) {
		if (file.path === 'client.js') {
			routes.push({
				pattern: '/client.js',
				strategy: 'static',
				version: digest(file.bytes, 'sha384')
			});
			continue;
		}
		if (file.path.startsWith('_nuxt/')) {
			routes.push({
				pattern: `/${file.path}`,
				strategy: 'static',
				version: digest(file.bytes, 'sha256')
			});
			continue;
		}
		if (!file.path.endsWith('.html')) continue;
		const route = routeOfHtml(file.path);
		if (route === null) continue;
		routes.push({
			pattern: route,
			strategy: 'static',
			version: digest(file.bytes, 'sha256'),
			freshness: { maxStale: 3600, mode: 'soft' }
		});
	}
	routes.sort((a, b) => a.pattern.localeCompare(b.pattern));
	return { schema: 1, routes };
}

async function listFiles(root: string, dir = root): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listFiles(root, full)));
		else out.push(relative(root, full).split('\\').join('/'));
	}
	return out;
}

async function main(): Promise<void> {
	const out = fileURLToPath(new URL('../.output/public/', import.meta.url));
	const cdn = fileURLToPath(
		new URL('../node_modules/@drupflare/spool/dist/cdn/', import.meta.url)
	);
	await mkdir(out, { recursive: true });
	await copyFile(join(cdn, 'client.js'), join(out, 'client.js'));
	await copyFile(join(cdn, 'spool-sw.js'), join(out, 'spool-sw.js'));
	const files: BuiltFile[] = [];
	for (const path of await listFiles(out)) {
		if (path === 'spool.json') continue;
		files.push({ path, bytes: await readFile(join(out, path)) });
	}
	const manifest = buildSpoolManifest(files);
	await writeFile(join(out, 'spool.json'), `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`spool.json: ${manifest.routes.length} static route(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await main();
}
