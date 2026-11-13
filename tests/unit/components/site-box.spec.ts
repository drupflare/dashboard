import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SiteBox from '~/components/site/Box.vue';
import SiteFound from '~/components/site/Found.vue';
import SiteMissing from '~/components/site/Missing.vue';
import SiteRename from '~/components/site/Rename.vue';
import {
	BOX_SITE_ELSEWHERE,
	boxDeleteCase,
	boxDeleteNote,
	missingSinceNote
} from '~/shared/box-sites';
import { useSessionStore } from '~/stores/session';
import { useSitesStore, type SiteSummary } from '~/stores/sites';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const ORG = 'org_personal';
const renamePath = `POST /api/v1/orgs/${ORG}/sites/site_1/rename`;

const site = (patch: Partial<SiteSummary> = {}): SiteSummary => ({
	id: 'site_1',
	orgId: ORG,
	name: 'Site 1 on campus-box',
	kind: 'drupal',
	category: 'cms',
	plane: 'self-hosted',
	config: 'canonical',
	accountId: null,
	state: 'active',
	ring: 'R0',
	primaryHostname: null,
	hostnames: [],
	admin: { username: null, email: null, password: 'unknown' },
	box: { found: true, missingSince: null },
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z',
	...patch
});

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

async function mountIt<T>(component: T, props: Record<string, unknown>) {
	const wrapper = await mountSuspended(component as never, { props } as never);
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useSitesStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('the box markers', () => {
	it('shows Found on Your Box as an icon and text', async () => {
		const wrapper = await mountIt(SiteFound, {});
		expect(wrapper.text()).toBe('Found on Your Box');
		expect(wrapper.html()).toContain('radar');
	});

	it('shows Not on the Box as an icon and text', async () => {
		const wrapper = await mountIt(SiteMissing, {});
		expect(wrapper.text()).toBe('Not on the Box');
		expect(wrapper.html()).toContain('unplug');
	});
});

describe('the box notice', () => {
	it('says the box reported the site and that nothing changed on it', async () => {
		const wrapper = await mountIt(SiteBox, {
			site: site({ primaryHostname: 'www.example.edu', name: 'www-example-edu' })
		});
		expect(wrapper.find('[data-test="found-note"]').text()).toContain(
			'Your box reported this site'
		);
		expect(wrapper.find('[data-test="found-note"]').text()).toContain(
			'Nothing was changed on the box'
		);
		expect(wrapper.find('[data-test="name-note"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="missing-note"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('Rename Site');
	});

	it('explains a placeholder name when the box kept the address back', async () => {
		const wrapper = await mountIt(SiteBox, { site: site() });
		expect(wrapper.find('[data-test="name-note"]').text()).toContain('placeholder');
		expect(wrapper.find('[data-test="name-note"]').text()).toContain('Rename the site');
	});

	it('says a site is not on the box and offers the box page', async () => {
		const wrapper = await mountIt(SiteBox, {
			site: site({
				plane: 'self-hosted',
				box: { found: false, missingSince: '2026-02-01T00:00:00Z' }
			})
		});
		const note = wrapper.find('[data-test="missing-note"]');
		expect(note.text()).toContain('This site is not on the box right now.');
		expect(note.text()).toContain('remove it from your list');
		expect(note.text()).toMatch(/Not seen on the box since/);
		expect(note.find('a[href="/planes"]').text()).toBe('Check the Box');
		expect(wrapper.find('[data-test="found-note"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Rename Site');
	});

	it('shows both notes for a found site the box has since lost', async () => {
		const wrapper = await mountIt(SiteBox, {
			site: site({ box: { found: true, missingSince: '2026-02-01T00:00:00Z' } })
		});
		expect(wrapper.find('[data-test="found-note"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="missing-note"]').exists()).toBe(true);
	});

	it('shows nothing for a site with no box state, and for one with none of it', async () => {
		const { box: _box, ...plain } = site();
		const bare = await mountIt(SiteBox, { site: plain });
		expect(bare.find('[data-test="box-notice"]').exists()).toBe(false);
		const clear = await mountIt(SiteBox, {
			site: site({ box: { found: false, missingSince: null } })
		});
		expect(clear.find('[data-test="box-notice"]').exists()).toBe(false);
	});

	it('passes a rename up to the page', async () => {
		cleanup = registerApi({
			[renamePath]: { body: site({ name: 'Library Portal' }) }
		});
		const wrapper = await mountIt(SiteBox, { site: site() });
		const rename = wrapper.findComponent(SiteRename);
		rename.vm.$emit('renamed', site({ name: 'Library Portal' }));
		expect(wrapper.emitted('renamed')?.[0]?.[0]).toMatchObject({ name: 'Library Portal' });
	});
});

describe('rename a found site', () => {
	const props = { orgId: ORG, siteId: 'site_1', name: 'Site 1 on campus-box' };

	async function open() {
		const wrapper = await mountIt(SiteRename, props);
		await wrapper.find('button').trigger('click');
		return wrapper;
	}

	it('opens a field holding the current name', async () => {
		const wrapper = await open();
		expect((wrapper.find('input').element as HTMLInputElement).value).toBe(props.name);
		expect(wrapper.find('label').text()).toBe('Site Name');
	});

	it('sends the trimmed name, reports the site and closes', async () => {
		cleanup = registerApi({ [renamePath]: { body: site({ name: 'Library Portal' }) } });
		const wrapper = await open();
		await wrapper.find('input').setValue('  Library Portal  ');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.emitted('renamed')).toHaveLength(1));
		expect(calls.find((entry) => entry.path.endsWith('/rename'))?.body).toEqual({
			name: 'Library Portal'
		});
		await vi.waitFor(() => expect(wrapper.find('form').exists()).toBe(false));
	});

	it('keeps Save Name off while the field is empty', async () => {
		cleanup = registerApi({});
		const wrapper = await open();
		await wrapper.find('input').setValue('   ');
		const save = wrapper.findAll('button').find((button) => button.text() === 'Save Name');
		expect(save?.attributes('disabled')).toBeDefined();
		await wrapper.find('form').trigger('submit');
		expect(calls).toHaveLength(0);
	});

	it('shows the refusal and stays open', async () => {
		cleanup = registerApi({
			[renamePath]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'Another site already has this name',
					details: { reason: 'name_taken' },
					requestId: 'req_n'
				}
			}
		});
		const wrapper = await open();
		await wrapper.find('input').setValue('taken');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toBe('Another site already has this name')
		);
		expect(wrapper.emitted('renamed')).toBeUndefined();
	});

	it('closes on Cancel without sending anything', async () => {
		cleanup = registerApi({});
		const wrapper = await open();
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Cancel')!
			.trigger('click');
		expect(wrapper.find('form').exists()).toBe(false);
		expect(calls).toHaveLength(0);
	});
});

describe('the box copy', () => {
	it('reads which delete case a site is in', () => {
		expect(boxDeleteCase({ found: true, missingSince: null })).toBe('found');
		expect(boxDeleteCase({ found: true, missingSince: '2026-02-01T00:00:00Z' })).toBe('found');
		expect(boxDeleteCase({ found: false, missingSince: '2026-02-01T00:00:00Z' })).toBe('gone');
		expect(boxDeleteCase({ found: false, missingSince: null })).toBe('present');
	});

	it('writes a delete note for each case, and only the found case promises the site is not added back', () => {
		expect(boxDeleteNote('present')).toEqual([BOX_SITE_ELSEWHERE]);
		expect(boxDeleteNote('found').join(' ')).toContain('does not add it back');
		expect(boxDeleteNote('gone').join(' ')).not.toContain('does not add it back');
	});

	it('dates the last sighting', () => {
		expect(missingSinceNote('2026-02-01T12:00:00Z')).toMatch(
			/^Not seen on the box since .*2026/
		);
	});
});
