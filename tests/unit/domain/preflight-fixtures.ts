import type { Page } from '../../../src/server/domain/preflight';

// captured: a trimmed excerpt of a live response read on 2026-10-25, host rewritten to example.edu
// written: built from the documented markup of that system, with no live capture behind it

const page = (headers: Record<string, string>, body: string, status = 200): Page => ({
	url: 'https://www.example.edu/',
	status,
	headers,
	body
});

const head = (inner: string) =>
	`<!DOCTYPE html><html lang="en"><head>${inner}</head><body></body></html>`;

export const drupal11AcquiaCloudflare = page(
	{
		server: 'cloudflare',
		'x-drupal-dynamic-cache': 'UNCACHEABLE (poor cacheability)',
		'x-generator': 'Drupal 11 (https://www.drupal.org)',
		'x-drupal-cache': 'MISS',
		'x-ah-environment': 'prod',
		via: 'varnish',
		'cf-ray': 'a503fecd1e43abc2-IAD'
	},
	head(
		'<meta charset="utf-8" /><link rel="canonical" href="https://www.example.edu/" />' +
			'<meta name="Generator" content="Drupal 11 (https://www.drupal.org)" />' +
			'<script src="/core/assets/vendor/jquery/jquery.min.js?v=4.0.0"></script>' +
			'<script type="application/json" data-drupal-selector="drupal-settings-json">{}</script>'
	)
);

export const drupal10Apache = page(
	{
		server: 'Apache/2.4.69 (Ubuntu)',
		'x-drupal-dynamic-cache': 'MISS',
		'x-generator': 'Drupal 10 (https://www.drupal.org)',
		'x-drupal-cache': 'HIT'
	},
	head(
		'<meta name="Generator" content="Drupal 10 (https://www.drupal.org)" />' +
			'<script type="application/json" data-drupal-selector="drupal-settings-json">{}</script>'
	)
);

export const wordpress = page(
	{
		'x-powered-by': 'PHP/8.3.36',
		link: '<https://www.example.edu/wp-json/>; rel="https://api.w.org/"'
	},
	head(
		'<meta name="generator" content="WordPress 7.1.3" />' +
			"<link rel='stylesheet' href='https://www.example.edu/wp-content/plugins/x/x.css?ver=7.1.3' />" +
			'<script id="jquery-core-js" src="https://www.example.edu/wp-includes/js/jquery/jquery.min.js"></script>'
	)
);

export const drupal7 = page(
	{ 'x-generator': 'Drupal 7 (http://drupal.org)' },
	head(
		'<meta name="Generator" content="Drupal 7 (http://drupal.org)" />' +
			'<script src="https://www.example.edu/misc/drupal.js?abc"></script>' +
			'<script>jQuery.extend(Drupal.settings, {"basePath":"\\/"});</script>'
	)
);

export const drupal9TagOnly = page(
	{},
	head('<meta content="Drupal 9 (https://www.drupal.org)" name="generator" />')
);

export const joomla = page(
	{},
	head(
		'<meta name="generator" content="Joomla! - Open Source Content Management" />' +
			'<script src="/media/system/js/core.js?abc"></script>'
	)
);

export const obfuscated = page(
	{ server: 'nginx' },
	head('<title>Home</title><link rel="stylesheet" href="/assets/site.css" />')
);

export const modernMarkupOnly = page(
	{},
	head(
		'<script src="/core/misc/drupal.js"></script>' +
			'<script type="application/json" data-drupal-selector="drupal-settings-json">{}</script>'
	)
);

export const lyingGenerator = page(
	{ 'x-generator': 'Drupal 11 (https://www.drupal.org)' },
	head(
		'<meta name="generator" content="Drupal 11 (https://www.drupal.org)" />' +
			'<link rel="stylesheet" href="/wp-content/themes/x/style.css" />'
	)
);

export const blocked = page(
	{ server: 'cloudflare', 'cf-ray': 'abc-IAD', 'cf-mitigated': 'challenge' },
	'<html><title>Just a moment...</title></html>',
	403
);

export const notFoundButDrupal = page(
	{ 'x-generator': 'Drupal 11 (https://www.drupal.org)' },
	head('<title>Page not found</title>'),
	404
);

export const wpImageOnADrupalSite = page(
	{ 'x-generator': 'Drupal 10 (https://www.drupal.org)' },
	head('<meta name="generator" content="Drupal 10 (https://www.drupal.org)" />').replace(
		'<body>',
		'<body><img src="https://blog.example.com/wp-content/uploads/a.jpg">'
	)
);

export const pantheonDrupal = page(
	{ 'x-pantheon-styx-hostname': 'styx-1', 'x-generator': 'Drupal 11 (https://www.drupal.org)' },
	head('')
);

export const coreChangelog = 'Drupal 10.3.1, 2024-07-17\n------------------------\n- Fixed bugs.\n';
export const coreChangelogDev = 'Drupal 11.2.x-dev, 2025-03-01\n---\n';
export const rootChangelog7 = 'Drupal 7.98, 2023-12-06\n-----------------------\n- Fixed.\n';
export const softNotFound = '<!DOCTYPE html><html><body>Page not found</body></html>';

export const robotsDrupal8 =
	'# robots.txt\nUser-agent: *\nCrawl-delay: 10\nDisallow: /core/\nDisallow: /profiles/\nDisallow: /admin/\n';
export const robotsDrupal7 =
	'User-agent: *\nDisallow: /includes/\nDisallow: /misc/\nDisallow: /modules/\n';
export const robotsWordpress =
	'User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n';
export const robotsJoomla = 'User-agent: *\nDisallow: /administrator/\nDisallow: /components/\n';
export const robotsPlain = 'User-agent: *\nDisallow: /private/\n';
