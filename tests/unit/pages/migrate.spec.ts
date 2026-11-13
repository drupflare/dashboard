import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import MigratePage from '~/pages/migrate/index.vue';
import PreflightPage from '~/pages/migrate/preflight.vue';
import { SURVEY_ONLY_NOTE } from '~/shared/preflight';
import { calls, clearBrowserState, registerApi, type Reply } from '../stores/store-support';

const route = 'POST /api/v1/preflight';

const drupal11 = {
	url: 'https://example.edu/',
	reachable: true,
	cms: 'drupal',
	version: '11.0.1',
	versionSource: 'https://example.edu/core/CHANGELOG.txt',
	hosting: 'Acquia, behind Cloudflare',
	signals: [
		{
			kind: 'header',
			detail: 'The X-Generator header says "Drupal 11 (https://www.drupal.org)".'
		},
		{ kind: 'file', detail: 'https://example.edu/core/CHANGELOG.txt prints "Drupal 11.0.1".' }
	],
	verdict: 'candidate',
	notes: ['Drupal 11.0.1 is the version Drupflare imports from a Linux server over SSH.']
};

const unreachable = {
	url: 'https://nothing.example/',
	reachable: false,
	cms: 'unknown',
	version: null,
	versionSource: null,
	hosting: null,
	signals: [],
	verdict: 'cannot tell',
	notes: ['We could not find that address. Check the spelling and try again.']
};

const failure = (status: number, code: string, message: string, details = {}) => ({
	status,
	body: { code, message, details, requestId: 'req_1' }
});

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => clearBrowserState());

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPreflight(reply: Reply | (() => Reply | Promise<Reply>)) {
	cleanup = registerApi({ [route]: reply });
	const wrapper = await mountSuspended(PreflightPage, { route: '/migrate/preflight' });
	mounted.push(wrapper);
	return wrapper;
}

async function submit(wrapper: Awaited<ReturnType<typeof mountPreflight>>, value: string) {
	await wrapper.find('input[name="url"]').setValue(value);
	await wrapper.find('form').trigger('submit');
	await flush();
}

const flush = async () => {
	for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe('migrate page', () => {
	it('says what moves, what needs an upgrade and what is not yet supported, in plain words', async () => {
		const wrapper = await mountSuspended(MigratePage, { route: '/migrate' });
		mounted.push(wrapper);
		const text = wrapper.text();
		for (const part of [
			'Move a Drupal Site to Drupflare',
			'What Moves Today',
			'Drupal 11 sites on a Linux server',
			'What Needs an Upgrade First',
			'Drupal 7 through 10',
			'What Is Not Yet Supported',
			'WordPress and Joomla',
			'What the Move Does to Your Server',
			'Nothing.',
			'What Carries Over',
			'What Does Not Carry Over',
			'private files folder',
			'Three Next Steps'
		]) {
			expect(text, part).toContain(part);
		}
		expect(text.toLowerCase()).not.toContain('compatible');
		expect(text).not.toMatch(/\bnever\b.*wordpress/i);
	});

	it('links the three next steps, with the sign-in return to the import screen', async () => {
		const wrapper = await mountSuspended(MigratePage, { route: '/migrate' });
		mounted.push(wrapper);
		const hrefs = wrapper.findAll('a').map((link) => link.attributes('href'));
		expect(hrefs).toContain('/migrate/preflight');
		expect(hrefs).toContain('/login?redirect=/new/import');
	});
});

describe('preflight page', () => {
	it('starts with the field, the button and what the check sends, and no result', async () => {
		const wrapper = await mountPreflight({ body: drupal11 });
		expect(wrapper.find('label[for="preflight-address"]').text()).toBe('Site Address');
		expect(wrapper.find('button[type="submit"]').text()).toBe('Check Address');
		expect(wrapper.text()).toContain('a handful of ordinary page requests');
		expect(wrapper.find('#preflight-verdict').exists()).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it('asks for an address before it sends anything', async () => {
		const wrapper = await mountPreflight({ body: drupal11 });
		await submit(wrapper, '   ');
		expect(wrapper.find('[role="alert"]').text()).toContain('Enter the address of a site.');
		expect(wrapper.find('input').attributes('aria-invalid')).toBe('true');
		expect(calls).toHaveLength(0);
	});

	it('sends a bare name as https and shows the verdict, the signals and the survey sentence', async () => {
		const wrapper = await mountPreflight({ body: drupal11 });
		await submit(wrapper, ' example.edu ');
		expect(calls[0]?.body).toEqual({ url: 'https://example.edu' });
		const heading = wrapper.find('#preflight-verdict');
		expect(heading.text()).toContain('Worth a Server Survey');
		const text = wrapper.text();
		expect(text).toContain('Drupal');
		expect(text).toContain('11.0.1, printed by https://example.edu/core/CHANGELOG.txt');
		expect(text).toContain('Acquia, behind Cloudflare');
		expect(text).toContain('Response Header');
		expect(text).toContain('Version File');
		expect(text).toContain(SURVEY_ONLY_NOTE);
		expect(text.toLowerCase()).not.toContain('compatible');
		const link = wrapper.findAll('a').find((a) => a.text().includes('Create an Account'));
		expect(link?.attributes('href')).toBe('/login?redirect=/new/import');
		expect(link?.text()).toBe('Create an Account to Connect Your Server');
	});

	it('shows the verdict as words and an icon, not as colour', async () => {
		const wrapper = await mountPreflight({
			body: { ...drupal11, verdict: 'needs upgrade', version: '10.3.1' }
		});
		await submit(wrapper, 'https://example.edu');
		const heading = wrapper.find('#preflight-verdict');
		expect(heading.text()).toBe('Needs an Upgrade First');
		expect(heading.find('[aria-hidden="true"]').exists()).toBe(true);
	});

	it('says so when the site showed nothing to read and prints no version', async () => {
		const wrapper = await mountPreflight({
			body: {
				...drupal11,
				cms: 'unknown',
				version: null,
				versionSource: null,
				hosting: null,
				signals: [],
				verdict: 'cannot tell',
				notes: ['The site does not disclose what it runs.']
			}
		});
		await submit(wrapper, 'example.edu');
		const text = wrapper.text();
		expect(text).toContain('Cannot Tell From Outside');
		expect(text).toContain('Not Disclosed');
		expect(text).toContain('Not printed on any page the check read');
		expect(text).toContain('Not visible from outside');
		expect(text).toContain('The site showed nothing the check could read.');
	});

	it('shows an unreachable address as a failure without a verdict or a signup link', async () => {
		const wrapper = await mountPreflight({ body: unreachable });
		await submit(wrapper, 'nothing.example');
		expect(wrapper.find('#preflight-verdict').text()).toContain('Could Not Read This Address');
		expect(wrapper.text()).toContain('We could not find that address.');
		expect(wrapper.text()).not.toContain('Create an Account');
		expect(wrapper.text()).not.toContain('What the Check Saw');
	});

	it('shows a refusal under the field in the server sentence', async () => {
		const wrapper = await mountPreflight(
			failure(422, 'unprocessable', 'The check reads only http and https addresses.', {
				reason: 'protocol'
			})
		);
		await submit(wrapper, 'ftp://example.edu');
		expect(wrapper.find('[role="alert"]').text()).toContain(
			'The check reads only http and https addresses.'
		);
		expect(wrapper.find('#preflight-verdict').exists()).toBe(false);
		expect(wrapper.text()).not.toMatch(/protocol_|unprocessable/);
	});

	it('shows the wait when the limit is reached', async () => {
		const wrapper = await mountPreflight(
			failure(429, 'rate_limited', 'Too many requests', { retryAfterSeconds: 42 })
		);
		await submit(wrapper, 'example.edu');
		expect(wrapper.find('[role="alert"]').text()).toContain('Try again in 42 seconds.');
	});

	it('shows a plain message when the server fails', async () => {
		const wrapper = await mountPreflight({ status: 500, body: null });
		await submit(wrapper, 'example.edu');
		expect(wrapper.find('[role="alert"]').text()).toContain('Try again');
	});

	it('shows a loading note while the check runs and clears the old result', async () => {
		let release: (reply: Reply) => void = () => undefined;
		const wrapper = await mountPreflight(
			() => new Promise<Reply>((resolve) => (release = resolve))
		);
		await wrapper.find('input[name="url"]').setValue('example.edu');
		await wrapper.find('form').trigger('submit');
		await flush();
		expect(wrapper.text()).toContain('Checking the address.');
		expect(wrapper.find('[aria-live="polite"]').attributes('aria-busy')).toBe('true');
		release({ body: drupal11 });
		await flush();
		expect(wrapper.text()).not.toContain('Checking the address.');
		expect(wrapper.find('#preflight-verdict').exists()).toBe(true);
	});
});
