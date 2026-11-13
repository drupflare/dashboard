import type { Cms, PreflightResult, PreflightSignal, Verdict } from '../../shared/preflight';
import { DRUPAL_MAJOR } from './dossier';

export interface Page {
	url: string;
	status: number;
	headers: Record<string, string>;
	body: string;
}

type Named = Exclude<Cms, 'unknown'>;

// min and max bound the Drupal majors a claim allows; other systems carry 0 and 0
export interface Claim {
	cms: Named;
	min: number;
	max: number;
	version: string | null;
	source: string | null;
}

export interface Reading {
	signals: PreflightSignal[];
	claims: Claim[];
	weak: Named[];
	platform: string | null;
	cloudflare: boolean;
	blocked: boolean;
}

const ANY_DRUPAL = { min: 7, max: 99 };
const MODERN_DRUPAL = { min: 8, max: 99 };
const BLOCKING_STATUSES = new Set([401, 403, 429]);
const CHANGELOG = /^Drupal (\d+(?:\.\d+)*(?:\.x)?(?:-[0-9A-Za-z.]+)?),/;
const GENERATOR = /^\s*(Drupal|WordPress|Joomla!?)\s*(\d+(?:\.\d+){0,2})?/i;

const empty = (): Reading => ({
	signals: [],
	claims: [],
	weak: [],
	platform: null,
	cloudflare: false,
	blocked: false
});

// a header value comes from the site, so it is shortened and stripped of control characters
function clip(value: string): string {
	// eslint-disable-next-line no-control-regex
	return value
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.trim()
		.slice(0, 80);
}

function generatorClaim(value: string, source: string): Claim | null {
	const match = GENERATOR.exec(value);
	if (!match?.[1]) return null;
	const name = match[1].toLowerCase().replace('!', '');
	const version = match[2] ?? null;
	if (name === 'drupal') {
		const major = version === null ? null : Number(version.split('.')[0]);
		const range = major === null ? ANY_DRUPAL : { min: major, max: major };
		return { cms: 'drupal', ...range, version, source: version === null ? null : source };
	}
	return {
		cms: name as Named,
		min: 0,
		max: 0,
		version,
		source: version === null ? null : source
	};
}

function attributeOf(tag: string, name: string): string | null {
	const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
	return match ? (match[1] ?? match[2] ?? null) : null;
}

// only code assets count; an image or a link to another site says nothing about this one
function assetPaths(body: string): string[] {
	const found: string[] = [];
	for (const tag of body.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
		const path = attributeOf(tag, 'src') ?? attributeOf(tag, 'href');
		if (path !== null) found.push(path);
	}
	return found;
}

function claim(reading: Reading, found: Claim, detail: string, kind: 'header' | 'markup'): void {
	reading.claims.push(found);
	reading.signals.push({ kind, detail });
}

function readHeaders(page: Page, reading: Reading): void {
	const h = page.headers;
	const generator = h['x-generator'];
	if (generator !== undefined) {
		const found = generatorClaim(generator, 'the X-Generator header on the home page');
		const text = `The X-Generator header says "${clip(generator)}".`;
		if (found) claim(reading, found, text, 'header');
		else reading.signals.push({ kind: 'header', detail: text });
	}
	if (h['x-drupal-cache'] !== undefined) {
		const found: Claim = { cms: 'drupal', ...ANY_DRUPAL, version: null, source: null };
		claim(
			reading,
			found,
			'The X-Drupal-Cache header is present, and Drupal sends it.',
			'header'
		);
	}
	if (h['x-drupal-dynamic-cache'] !== undefined) {
		const found: Claim = { cms: 'drupal', ...MODERN_DRUPAL, version: null, source: null };
		const text = 'The X-Drupal-Dynamic-Cache header is present, which means Drupal 8 or later.';
		claim(reading, found, text, 'header');
	}
	if (h['link'] !== undefined && /rel=["']?https:\/\/api\.w\.org\/?["']?/i.test(h['link'])) {
		const found: Claim = { cms: 'wordpress', min: 0, max: 0, version: null, source: null };
		claim(reading, found, 'The Link header points to the WordPress REST API.', 'header');
	}
	if (h['server'] !== undefined) {
		reading.signals.push({
			kind: 'header',
			detail: `The Server header says "${clip(h['server'])}".`
		});
	}
	if (h['x-powered-by'] !== undefined) {
		const text = `The X-Powered-By header says "${clip(h['x-powered-by'])}".`;
		reading.signals.push({ kind: 'header', detail: text });
	}
	if (h['via'] !== undefined) {
		const text = `The Via header says "${clip(h['via'])}", a cache in front of the site.`;
		reading.signals.push({ kind: 'header', detail: text });
	}
	if (h['x-ah-environment'] !== undefined) {
		reading.platform = 'Acquia';
		reading.signals.push({
			kind: 'header',
			detail: 'The X-AH-Environment header is an Acquia marker.'
		});
	} else if (h['x-pantheon-styx-hostname'] !== undefined) {
		reading.platform = 'Pantheon';
		const text = 'The X-Pantheon-Styx-Hostname header is a Pantheon marker.';
		reading.signals.push({ kind: 'header', detail: text });
	}
	if (h['cf-ray'] !== undefined || h['server']?.toLowerCase() === 'cloudflare') {
		reading.cloudflare = true;
		reading.signals.push({ kind: 'header', detail: 'The response came through Cloudflare.' });
	}
}

function readMarkup(page: Page, reading: Reading): void {
	const body = page.body;
	for (const tag of body.match(/<meta\b[^>]*>/gi) ?? []) {
		if (attributeOf(tag, 'name')?.toLowerCase() !== 'generator') continue;
		const content = attributeOf(tag, 'content');
		if (content === null) continue;
		const found = generatorClaim(content, 'the generator tag on the home page');
		const text = `The generator tag says "${clip(content)}".`;
		if (found) claim(reading, found, text, 'markup');
		else reading.signals.push({ kind: 'markup', detail: text });
	}
	const paths = assetPaths(body);
	const rules: Array<[boolean, Claim, string]> = [
		[
			paths.some((path) => /\/core\/(?:misc|assets|themes|modules)\//.test(path)),
			{ cms: 'drupal', ...MODERN_DRUPAL, version: null, source: null },
			'The home page loads scripts or styles from /core/, the folder Drupal 8 and later use.'
		],
		[
			/data-drupal-selector=["']drupal-settings-json["']/i.test(body),
			{ cms: 'drupal', ...MODERN_DRUPAL, version: null, source: null },
			'The home page carries the settings block Drupal 8 and later print.'
		],
		[
			paths.some((path) => /(?<!\/core)\/misc\/drupal\.js/.test(path)),
			{ cms: 'drupal', min: 7, max: 7, version: null, source: null },
			'The home page loads /misc/drupal.js, a Drupal 7 script.'
		],
		[
			/\bDrupal\.settings\b/.test(body),
			{ cms: 'drupal', min: 7, max: 7, version: null, source: null },
			'The home page sets Drupal.settings, which Drupal 7 does.'
		],
		[
			paths.some((path) => /\/wp-(?:content|includes)\//.test(path)),
			{ cms: 'wordpress', min: 0, max: 0, version: null, source: null },
			'The home page loads scripts or styles from /wp-content/ or /wp-includes/.'
		],
		[
			paths.some((path) => /\/media\/system\//.test(path)),
			{ cms: 'joomla', min: 0, max: 0, version: null, source: null },
			'The home page loads scripts or styles from /media/system/, a Joomla folder.'
		]
	];
	for (const [hit, found, text] of rules) if (hit) claim(reading, found, text, 'markup');
}

export function readHome(page: Page): Reading {
	const reading = empty();
	if (page.status >= 400) {
		reading.signals.push({
			kind: 'status',
			detail: `The home page answered with status ${page.status}.`
		});
	}
	reading.blocked =
		BLOCKING_STATUSES.has(page.status) || page.headers['cf-mitigated'] === 'challenge';
	readHeaders(page, reading);
	readMarkup(page, reading);
	return reading;
}

export function readChangelog(url: string, status: number, text: string, core: boolean): Reading {
	const reading = empty();
	if (status !== 200) return reading;
	const version = CHANGELOG.exec(text.trimStart().slice(0, 200))?.[1];
	if (version === undefined) return reading;
	const major = Number(version.split('.')[0]);
	if (core && major < 8) return reading;
	reading.claims.push({ cms: 'drupal', min: major, max: major, version, source: url });
	reading.signals.push({ kind: 'file', detail: `${url} prints "Drupal ${version}".` });
	return reading;
}

const disallows = (text: string, ...paths: string[]) =>
	paths.every((path) => new RegExp(`^disallow:\\s*${path}\\s*$`, 'im').test(text));

export function readRobots(status: number, text: string): Reading {
	const reading = empty();
	if (status !== 200) return reading;
	const rules: Array<[boolean, Named, string]> = [
		[disallows(text, '/core/', '/profiles/'), 'drupal', 'Drupal 8 or later'],
		[
			disallows(text, '/includes/', '/misc/') && !disallows(text, '/core/'),
			'drupal',
			'Drupal 7'
		],
		[disallows(text, '/wp-admin/'), 'wordpress', 'WordPress'],
		[disallows(text, '/administrator/', '/components/'), 'joomla', 'Joomla']
	];
	for (const [hit, cms, label] of rules) {
		if (!hit) continue;
		reading.weak.push(cms);
		reading.signals.push({
			kind: 'robots',
			detail: `The robots file matches the default ${label} file.`
		});
	}
	return reading;
}

export function merge(readings: readonly Reading[]): Reading {
	const all = empty();
	for (const reading of readings) {
		all.signals.push(...reading.signals);
		all.claims.push(...reading.claims);
		all.weak.push(...reading.weak);
		all.platform ??= reading.platform;
		all.cloudflare ||= reading.cloudflare;
		all.blocked ||= reading.blocked;
	}
	return all;
}

export interface Wanted {
	core: boolean;
	root: boolean;
	robots: boolean;
}

// which of the three follow-up files are worth a request, given what the home page showed
export function followUps(reading: Reading): Wanted {
	const none = { core: false, root: false, robots: false };
	if (reading.blocked) return none;
	const cms = new Set(reading.claims.map((found) => found.cms));
	if (cms.size > 1 || cms.has('wordpress') || cms.has('joomla')) return none;
	const drupal = reading.claims.filter((found) => found.cms === 'drupal');
	const low = Math.max(7, ...drupal.map((found) => found.min));
	const high = Math.min(99, ...drupal.map((found) => found.max));
	return {
		core: drupal.length === 0 || high >= 8,
		root: drupal.length === 0 || low === 7,
		robots: drupal.length === 0
	};
}

function bestVersion(claims: Claim[], major: number): Claim | undefined {
	const printed = claims.filter(
		(found) => found.version !== null && Number(found.version.split('.')[0]) === major
	);
	return printed.sort(
		(a, b) => (b.version?.split('.').length ?? 0) - (a.version?.split('.').length ?? 0)
	)[0];
}

interface Outcome {
	cms: Cms;
	version: string | null;
	versionSource: string | null;
	verdict: Verdict;
	notes: string[];
}

const UNKNOWN: Outcome = {
	cms: 'unknown',
	version: null,
	versionSource: null,
	verdict: 'cannot tell',
	notes: []
};

function decideDrupal(claims: Claim[]): Outcome {
	const lo = Math.max(...claims.map((found) => found.min));
	const hi = Math.min(...claims.map((found) => found.max));
	const base: Outcome = { ...UNKNOWN, cms: 'drupal', notes: [] };
	if (lo > hi) {
		base.notes.push(
			'The pages disagree about the Drupal version, so the check does not pick one.'
		);
		return base;
	}
	if (lo < hi) {
		const from = lo >= 8 ? 'Drupal 8 or later' : 'Drupal';
		base.notes.push(`The site shows ${from} markup, but no page printed which version it is.`);
		return base;
	}
	const best = bestVersion(claims, lo);
	const label = best?.version ?? String(lo);
	const out: Outcome = {
		...base,
		version: best?.version ?? null,
		versionSource: best?.source ?? null
	};
	if (lo > DRUPAL_MAJOR) {
		out.verdict = 'not yet supported';
		out.notes.push(
			`Drupal ${label} is newer than the Drupal ${DRUPAL_MAJOR} that Drupflare imports today.`
		);
	} else if (lo < DRUPAL_MAJOR) {
		out.verdict = 'needs upgrade';
		out.notes.push(
			`Drupal ${label} is older than the Drupal ${DRUPAL_MAJOR} that Drupflare imports today, so the upgrade comes first.`
		);
	} else {
		out.verdict = 'candidate';
		out.notes.push(
			`Drupal ${label} is the version Drupflare imports from a Linux server over SSH. The server survey confirms the rest.`
		);
	}
	if (best === undefined)
		out.notes.push(
			'No page printed a version number; the major version comes from page markup.'
		);
	return out;
}

function decide(claims: Claim[], weak: Named[]): Outcome {
	const names = [...new Set(claims.map((found) => found.cms))];
	if (names.length > 1) {
		return {
			...UNKNOWN,
			notes: ['The site points to more than one system, so the check does not pick one.']
		};
	}
	const only = names[0];
	if (only === 'drupal') return decideDrupal(claims);
	if (only !== undefined) {
		const best = claims.find((found) => found.version !== null);
		const label = only === 'wordpress' ? 'WordPress' : 'Joomla';
		return {
			cms: only,
			version: best?.version ?? null,
			versionSource: best?.source ?? null,
			verdict: 'not yet supported',
			notes: [`The site looks like ${label}. Drupflare does not move ${label} sites yet.`]
		};
	}
	const out = { ...UNKNOWN, notes: [] as string[] };
	if (weak.length > 0) {
		out.notes.push(
			'The robots file looks like a default one, which is not enough to name the system.'
		);
	}
	out.notes.push(
		'The site does not disclose what it runs. Many sites hide it, and that says nothing against a move.'
	);
	return out;
}

function hostingOf(reading: Reading): string | null {
	if (reading.platform !== null) {
		return reading.cloudflare ? `${reading.platform}, behind Cloudflare` : reading.platform;
	}
	return reading.cloudflare ? 'Behind Cloudflare, so the host behind it is not visible' : null;
}

export interface Conclusion {
	url: string;
	reading: Reading;
}

export function conclude(input: Conclusion): PreflightResult {
	const { reading } = input;
	let outcome = decide(reading.claims, reading.weak);
	if (reading.blocked) {
		const refused =
			'The site refused the request, which usually means it blocks automated checks.';
		outcome =
			outcome.cms === 'unknown'
				? { ...UNKNOWN, notes: [refused] }
				: { ...outcome, notes: [refused, ...outcome.notes] };
	}
	return {
		url: input.url,
		reachable: true,
		cms: outcome.cms,
		version: outcome.version,
		versionSource: outcome.versionSource,
		hosting: hostingOf(reading),
		signals: reading.signals,
		verdict: outcome.verdict,
		notes: outcome.notes
	};
}

const SECOND_LEVEL = new Set([
	'co.uk',
	'org.uk',
	'ac.uk',
	'gov.uk',
	'com.au',
	'edu.au',
	'org.au',
	'gov.au',
	'net.au',
	'co.nz',
	'ac.nz',
	'org.nz',
	'co.jp',
	'ac.jp',
	'or.jp',
	'com.br',
	'edu.br',
	'com.mx',
	'edu.mx',
	'co.in',
	'ac.in',
	'edu.in',
	'co.za',
	'ac.za',
	'com.cn',
	'edu.cn',
	'com.sg',
	'edu.sg',
	'com.hk',
	'edu.hk',
	'co.kr',
	'ac.kr'
]);

// the last two labels, or three under a known second-level suffix; the list is short on purpose
export function registrableDomain(hostname: string): string {
	const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
	if (labels.length <= 2) return labels.join('.');
	const tail = labels.slice(-2).join('.');
	return SECOND_LEVEL.has(tail) ? labels.slice(-3).join('.') : tail;
}

export const sameSite = (from: URL, to: URL): boolean =>
	registrableDomain(from.hostname) === registrableDomain(to.hostname);
