import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.SITE_DIR ?? join(here, 'site');
const pkg =
	process.env.SPOOL_CDN ??
	join(here, '..', '..', '..', 'node_modules', '@drupflare', 'spool', 'dist', 'cdn');
const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const tag = process.env.SPIKE_NO_CLIENT
	? ''
	: '<script src="/client.js" defer data-spool-client></script>';

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'docs'), { recursive: true });

const page = (name) => `<!doctype html><html><head><meta charset="utf-8"><title>Doc ${name}</title>
<link rel="stylesheet" href="/docs/style.css"><script src="/docs/app.js" defer></script>${tag}</head>
<body><h1>Doc ${name}</h1><nav>${names.map((n) => `<a id="to-${n}" href="/docs/${n}">${n}</a>`).join(' ')}</nav>
<a id="to-missing" href="/docs/unlisted">unlisted</a></body></html>`;

const files = { 'docs/style.css': 'body{font:16px sans-serif}', 'docs/app.js': 'window.__app=1;' };
for (const n of [...names, 'unlisted']) files[`docs/${n}.html`] = page(n);
for (const [path, body] of Object.entries(files)) writeFileSync(join(out, path), body);

copyFileSync(join(pkg, 'spool-sw.js'), join(out, 'spool-sw.js'));
copyFileSync(join(pkg, 'client.js'), join(out, 'client.js'));

const sha = (path, alg) =>
	`${alg}-${createHash(alg)
		.update(readFileSync(join(out, path)))
		.digest('base64')}`;
const route = (pattern, path, alg = 'sha256') => ({
	pattern,
	strategy: 'static',
	version: sha(path, alg)
});
const routes = [
	...names.map((n) => route(`/docs/${n}`, `docs/${n}.html`)),
	route('/docs/style.css', 'docs/style.css'),
	route('/docs/app.js', 'docs/app.js'),
	route('/client.js', 'client.js', 'sha384')
];
writeFileSync(join(out, 'spool.json'), JSON.stringify({ schema: 1, routes }, null, '\t'));
console.log(`built ${Object.keys(files).length + 3} files, ${routes.length} routes`);
