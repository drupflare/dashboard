import { describe, expect, it } from 'vitest';
import {
	conclude,
	followUps,
	merge,
	readChangelog,
	readHome,
	readRobots,
	registrableDomain,
	sameSite,
	type Page
} from '../../../src/server/domain/preflight';
import * as f from './preflight-fixtures';

const base = 'https://www.example.edu';
const run = (page: Page, ...more: ReturnType<typeof readHome>[]) =>
	conclude({ url: page.url, reading: merge([readHome(page), ...more]) });
const core = (status: number, text: string) =>
	readChangelog(`${base}/core/CHANGELOG.txt`, status, text, true);
const root = (status: number, text: string) =>
	readChangelog(`${base}/CHANGELOG.txt`, status, text, false);
const details = (result: ReturnType<typeof run>) => result.signals.map((s) => s.detail).join('\n');

describe('home page signals', () => {
	it('reads a Drupal 11 site behind Cloudflare on Acquia from the header and the tag', () => {
		const result = run(f.drupal11AcquiaCloudflare);
		expect(result).toMatchObject({
			cms: 'drupal',
			version: '11',
			versionSource: 'the X-Generator header on the home page',
			hosting: 'Acquia, behind Cloudflare',
			verdict: 'candidate',
			reachable: true
		});
		const text = details(result);
		for (const part of [
			'X-Generator header says "Drupal 11',
			'generator tag says "Drupal 11',
			'/core/',
			'settings block',
			'X-Drupal-Cache',
			'X-Drupal-Dynamic-Cache',
			'Acquia marker',
			'Via header',
			'Cloudflare'
		]) {
			expect(text, part).toContain(part);
		}
	});

	it('says a Drupal 10 site needs an upgrade first, and names the version', () => {
		const result = run(f.drupal10Apache);
		expect(result).toMatchObject({ cms: 'drupal', version: '10', verdict: 'needs upgrade' });
		expect(result.hosting).toBeNull();
		expect(result.notes[0]).toContain('Drupal 10 is older than the Drupal 11');
		expect(details(result)).toContain('Server header says "Apache/2.4.69 (Ubuntu)"');
	});

	it('says a Drupal 7 site needs an upgrade, from the tag, the script and the settings call', () => {
		const result = run(f.drupal7);
		expect(result).toMatchObject({ cms: 'drupal', version: '7', verdict: 'needs upgrade' });
		expect(details(result)).toContain('/misc/drupal.js');
		expect(details(result)).toContain('Drupal.settings');
	});

	it('reads the generator tag when content comes before name', () => {
		const result = run(f.drupal9TagOnly);
		expect(result).toMatchObject({ version: '9', verdict: 'needs upgrade' });
		expect(result.versionSource).toBe('the generator tag on the home page');
	});

	it('does not read /core/misc/drupal.js as the Drupal 7 script', () => {
		expect(details(run(f.modernMarkupOnly))).not.toContain('Drupal 7 script');
	});

	it('reads WordPress as not yet supported, with its printed version', () => {
		const result = run(f.wordpress);
		expect(result).toMatchObject({
			cms: 'wordpress',
			version: '7.1.3',
			versionSource: 'the generator tag on the home page',
			verdict: 'not yet supported'
		});
		expect(result.notes[0]).toContain('does not move WordPress sites yet');
		expect(details(result)).toContain('REST API');
		expect(details(result)).toContain('/wp-content/');
	});

	it('reads Joomla as not yet supported and prints no version', () => {
		const result = run(f.joomla);
		expect(result).toMatchObject({
			cms: 'joomla',
			version: null,
			versionSource: null,
			verdict: 'not yet supported'
		});
		expect(details(result)).toContain('/media/system/');
	});

	it('says cannot tell for a site that discloses nothing', () => {
		const result = run(f.obfuscated);
		expect(result).toMatchObject({ cms: 'unknown', version: null, verdict: 'cannot tell' });
		expect(result.notes[0]).toContain('does not disclose');
		expect(result.hosting).toBeNull();
	});

	it('says cannot tell when Drupal 8 or later markup carries no version', () => {
		const result = run(f.modernMarkupOnly);
		expect(result).toMatchObject({ cms: 'drupal', version: null, verdict: 'cannot tell' });
		expect(result.notes[0]).toContain('Drupal 8 or later markup');
	});

	it('picks no system when a generator tag and an asset path disagree', () => {
		const result = run(f.lyingGenerator);
		expect(result).toMatchObject({ cms: 'unknown', version: null, verdict: 'cannot tell' });
		expect(result.notes[0]).toContain('more than one system');
	});

	it('ignores a WordPress image on a Drupal page', () => {
		expect(run(f.wpImageOnADrupalSite)).toMatchObject({ cms: 'drupal', version: '10' });
	});

	it('reports a blocked response as cannot tell and says it was refused', () => {
		const result = run(f.blocked);
		expect(result).toMatchObject({ cms: 'unknown', verdict: 'cannot tell' });
		expect(result.notes[0]).toContain('refused the request');
		expect(details(result)).toContain('status 403');
		expect(result.hosting).toContain('Cloudflare');
	});

	it('keeps what a refusal page reveals about the system', () => {
		const result = run({ ...f.blocked, headers: { 'x-generator': 'Drupal 11 (https://x)' } });
		expect(result.cms).toBe('drupal');
		expect(result.notes[0]).toContain('refused the request');
	});

	it('reads headers from a 404 page', () => {
		expect(run(f.notFoundButDrupal)).toMatchObject({ cms: 'drupal', verdict: 'candidate' });
	});

	it('names Pantheon', () => {
		expect(run(f.pantheonDrupal).hosting).toBe('Pantheon');
	});

	it('shortens and cleans a header value before showing it', () => {
		const long = `${'a'.repeat(200)}\n`;
		const result = run({ url: base, status: 200, headers: { server: long }, body: '' });
		const text = details(result);
		expect(text).toContain(`"${'a'.repeat(80)}"`);
		expect(text).not.toContain('\n');
	});

	it('shows a Drupal generator with no number as an unknown version', () => {
		const result = run({
			url: base,
			status: 200,
			headers: { 'x-generator': 'Drupal' },
			body: ''
		});
		expect(result).toMatchObject({ cms: 'drupal', version: null, verdict: 'cannot tell' });
	});

	it('shows a generator it does not know as a signal and no claim', () => {
		const page = { url: base, status: 200, headers: { 'x-generator': 'Hugo' }, body: '' };
		expect(run(page)).toMatchObject({ cms: 'unknown' });
		expect(details(run(page))).toContain('"Hugo"');
	});

	it('reads Drupal 12 as not yet supported', () => {
		const page = {
			url: base,
			status: 200,
			headers: { 'x-generator': 'Drupal 12.1' },
			body: ''
		};
		expect(run(page)).toMatchObject({ version: '12.1', verdict: 'not yet supported' });
	});
});

describe('version files', () => {
	it('reads the full version from the core changelog and prefers it to a major number', () => {
		const result = run(f.drupal10Apache, core(200, f.coreChangelog));
		expect(result).toMatchObject({
			version: '10.3.1',
			versionSource: `${base}/core/CHANGELOG.txt`,
			verdict: 'needs upgrade'
		});
		expect(details(result)).toContain('prints "Drupal 10.3.1"');
	});

	it('keeps a development version string as printed', () => {
		const result = run(f.obfuscated, core(200, f.coreChangelogDev));
		expect(result).toMatchObject({ version: '11.2.x-dev', verdict: 'candidate' });
	});

	it('reads a Drupal 7 version from the root changelog', () => {
		const result = run(f.obfuscated, root(200, f.rootChangelog7));
		expect(result).toMatchObject({ version: '7.98', verdict: 'needs upgrade' });
	});

	it('ignores a soft 404, a missing file and a Drupal 7 line at the core path', () => {
		for (const reading of [
			core(200, f.softNotFound),
			core(404, f.coreChangelog),
			core(200, f.rootChangelog7)
		]) {
			expect(reading.claims).toEqual([]);
		}
	});

	it('picks no version when the changelog and the header disagree', () => {
		const result = run(f.drupal11AcquiaCloudflare, core(200, f.coreChangelog));
		expect(result).toMatchObject({ cms: 'drupal', version: null, verdict: 'cannot tell' });
		expect(result.notes[0]).toContain('disagree');
	});
});

describe('robots file', () => {
	it.each([
		[f.robotsDrupal8, 'Drupal 8 or later'],
		[f.robotsDrupal7, 'Drupal 7'],
		[f.robotsWordpress, 'WordPress'],
		[f.robotsJoomla, 'Joomla']
	])('matches the default file for %#', (text, label) => {
		const reading = readRobots(200, text);
		expect(reading.signals).toEqual([
			{ kind: 'robots', detail: `The robots file matches the default ${label} file.` }
		]);
		expect(reading.claims).toEqual([]);
	});

	it('matches nothing in a custom file or a missing one', () => {
		expect(readRobots(200, f.robotsPlain).signals).toEqual([]);
		expect(readRobots(404, f.robotsDrupal8).signals).toEqual([]);
	});

	it('never names a system on its own', () => {
		const result = run(f.obfuscated, readRobots(200, f.robotsDrupal8));
		expect(result).toMatchObject({ cms: 'unknown', verdict: 'cannot tell' });
		expect(result.notes[0]).toContain('default one');
	});
});

describe('which follow-up files are worth a request', () => {
	const want = (page: Page) => followUps(readHome(page));

	it('asks for all three when the home page names nothing', () => {
		expect(want(f.obfuscated)).toEqual({ core: true, root: true, robots: true });
	});

	it('asks for the core changelog only when Drupal 11 is printed', () => {
		expect(want(f.drupal11AcquiaCloudflare)).toEqual({
			core: true,
			root: false,
			robots: false
		});
	});

	it('asks for the root changelog only when the markup says Drupal 7', () => {
		expect(want(f.drupal7)).toEqual({ core: false, root: true, robots: false });
	});

	it('asks for nothing when the site blocks the request or names another system', () => {
		const none = { core: false, root: false, robots: false };
		expect(want(f.blocked)).toEqual(none);
		expect(want(f.wordpress)).toEqual(none);
		expect(want(f.joomla)).toEqual(none);
		expect(want(f.lyingGenerator)).toEqual(none);
	});

	it('skips the root changelog once the core one printed a version', () => {
		const after = merge([readHome(f.obfuscated), core(200, f.coreChangelog)]);
		expect(followUps(after)).toEqual({ core: true, root: false, robots: false });
	});
});

describe('the verdict is never stronger than the signals', () => {
	const all = Object.entries(f).filter(([, value]) => typeof value === 'object') as Array<
		[string, Page]
	>;

	it.each(all)('%s', (_name, page) => {
		const result = run(page);
		if (result.verdict === 'candidate') {
			expect(result.cms).toBe('drupal');
			expect(details(result)).toMatch(/Drupal 11/);
		}
		if (result.version !== null) {
			expect(result.versionSource).not.toBeNull();
			expect(details(result)).toContain(result.version);
		}
		if (result.versionSource !== null) expect(result.version).not.toBeNull();
		expect(result.notes.length).toBeGreaterThan(0);
		const wording = `${result.notes.join(' ')} ${result.signals.map((s) => s.detail).join(' ')}`;
		expect(wording.toLowerCase()).not.toContain('compatible');
	});
});

describe('registrable domains', () => {
	it.each([
		['www.example.edu', 'example.edu'],
		['example.edu', 'example.edu'],
		['a.b.example.edu.', 'example.edu'],
		['www.school.ac.uk', 'school.ac.uk'],
		['school.ac.uk', 'school.ac.uk'],
		['uni.edu.au', 'uni.edu.au']
	])('%s is %s', (host, domain) => {
		expect(registrableDomain(host)).toBe(domain);
	});

	it('treats a www move as the same site and another domain as different', () => {
		expect(sameSite(new URL('http://example.edu/'), new URL('https://www.example.edu/'))).toBe(
			true
		);
		expect(sameSite(new URL('https://a.ac.uk/'), new URL('https://b.ac.uk/'))).toBe(false);
		expect(sameSite(new URL('https://example.edu/'), new URL('https://example.com/'))).toBe(
			false
		);
	});
});
