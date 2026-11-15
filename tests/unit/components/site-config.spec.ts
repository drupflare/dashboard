import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SiteConfigDiff from '~/components/site/config/Diff.vue';
import SiteConfigEffective from '~/components/site/config/Effective.vue';
import SiteConfigField from '~/components/site/config/Field.vue';
import SiteConfigForm from '~/components/site/config/Form.vue';
import SiteConfigHistory from '~/components/site/config/History.vue';
import SiteConfigWrangler from '~/components/site/config/Wrangler.vue';
import { useSiteConfigStore, type SettingsField, type SettingsGroup } from '~/stores/site-config';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const field = (over: Partial<SettingsField> = {}): SettingsField => ({
	key: 'WARM_INTERVAL_MS',
	label: 'Warm Interval',
	description: null,
	group: 'runtime',
	widget: 'lever-slider',
	bounds: { min: 8000, max: 600000, unit: 'ms' },
	schema: {
		'x-marks': [{ value: 8000, label: 'Default and Fastest', note: '10,800 wakes a day.' }]
	},
	value: 8000,
	provenance: 'default',
	danger: false,
	editable: false,
	readOnlyReason: 'Changing this here is not available yet.',
	...over
});

const group = (fields: SettingsField[]): SettingsGroup[] => [
	{ id: 'runtime', label: 'Runtime', fields }
];

describe('site config field', () => {
	it('shows a widget it does not know as formatted JSON', async () => {
		const wrapper = await mountSuspended(SiteConfigField, {
			props: {
				field: field({ widget: 'json', value: { a: 1 }, schema: {}, bounds: null })
			}
		});

		expect(wrapper.find('pre').text()).toContain('"a": 1');
	});

	it('marks a lever position with its mark label and the unit', async () => {
		const wrapper = await mountSuspended(SiteConfigField, { props: { field: field() } });

		expect(wrapper.text()).toContain('Default and Fastest');
		expect(wrapper.text()).toContain('ms');
	});

	it('never shows the value of a secret', async () => {
		const wrapper = await mountSuspended(SiteConfigField, {
			props: {
				field: field({ widget: 'secret', value: 'hunter2', schema: {}, bounds: null })
			}
		});

		expect(wrapper.text()).not.toContain('hunter2');
		expect(wrapper.text()).toContain('Set');
	});
});

describe('site config effective', () => {
	it('names where each value comes from in words', async () => {
		const wrapper = await mountSuspended(SiteConfigEffective, {
			props: { groups: group([field({ provenance: 'var' })]) }
		});

		expect(wrapper.text()).toContain('Deploy Setting');
	});
});

describe('site config wrangler view', () => {
	it('lists only deploy-time variables', async () => {
		const wrapper = await mountSuspended(SiteConfigWrangler, {
			props: {
				groups: group([
					field({ key: 'PAGE_KV_TTL', provenance: 'var', value: 86400 }),
					field({ key: 'WARM_INTERVAL_MS', provenance: 'kv', value: 9000 })
				])
			}
		});

		expect(wrapper.find('pre').text()).toContain('"PAGE_KV_TTL": 86400');
		expect(wrapper.find('pre').text()).not.toContain('WARM_INTERVAL_MS');
	});
});

const editable = (over: Partial<SettingsField> = {}): SettingsField =>
	field({
		widget: 'number',
		editable: true,
		readOnlyReason: null,
		bounds: { min: 8000, max: 600000, unit: 'ms' },
		schema: { type: 'integer', minimum: 8000, maximum: 600000 },
		value: null,
		provenance: 'default',
		...over
	});

const SETTINGS = '/api/v1/orgs/org_1/sites/site_1/settings';
let cleanup: () => void = () => undefined;

afterEach(() => {
	cleanup();
	clearBrowserState();
	useSiteConfigStore().reset();
	vi.restoreAllMocks();
});

const formProps = (fields: SettingsField[]) => ({
	groups: group(fields),
	orgId: 'org_1',
	siteId: 'site_1',
	etag: '"tag1"'
});

const buttonOf = (wrapper: { findAll: (s: string) => { text: () => string }[] }, text: string) =>
	(
		wrapper.findAll('button') as (ReturnType<typeof wrapper.findAll>[number] & {
			attributes: (n: string) => string | undefined;
			trigger: (e: string) => Promise<void>;
		})[]
	).find((b) => b.text() === text);

describe('site config field editing', () => {
	it('shows an input for an editable setting and reports what is typed', async () => {
		const wrapper = await mountSuspended(SiteConfigField, { props: { field: editable() } });
		await wrapper.get('input').setValue('30000');
		expect(wrapper.emitted('edit')?.at(-1)).toEqual([30000]);
		await wrapper.get('input').setValue('');
		expect(wrapper.emitted('edit')?.at(-1)).toEqual([null]);
	});

	it('shows the error beside the field and marks the input invalid', async () => {
		const wrapper = await mountSuspended(SiteConfigField, {
			props: { field: editable(), draft: 5, error: 'Too small.' }
		});
		expect(wrapper.get('[role="alert"]').text()).toContain('Too small.');
		expect(wrapper.get('input').attributes('aria-invalid')).toBe('true');
	});

	it('offers the default for an override and sends null for it', async () => {
		const wrapper = await mountSuspended(SiteConfigField, {
			props: { field: editable({ provenance: 'kv', value: 20000 }) }
		});
		const reset = buttonOf(wrapper, 'Use the Default');
		expect(reset).toBeDefined();
		await reset!.trigger('click');
		expect(wrapper.emitted('edit')?.at(-1)).toEqual([null]);
	});

	it('shows a switch for a flag and a choice for an enum', async () => {
		const flag = await mountSuspended(SiteConfigField, {
			props: {
				field: editable({
					widget: 'toggle',
					value: '0',
					schema: { type: 'string', enum: ['0', '1'] }
				})
			}
		});
		expect(flag.find('[role="switch"]').exists()).toBe(true);
		const choice = await mountSuspended(SiteConfigField, {
			props: {
				field: editable({
					widget: 'select',
					value: 'off',
					schema: { type: 'string', enum: ['off', 'enforce'] }
				})
			}
		});
		expect(choice.find('[role="combobox"]').exists()).toBe(true);
	});

	it('keeps a read-only setting free of inputs and gives the reason', async () => {
		const wrapper = await mountSuspended(SiteConfigField, {
			props: {
				field: editable({
					editable: false,
					readOnlyReason: 'Only the site owner can change this.'
				})
			}
		});
		expect(wrapper.find('input').exists()).toBe(false);
		expect(wrapper.text()).toContain('Only the site owner can change this.');
	});
});

describe('site config diff', () => {
	it('shows before and after with a word for the default', async () => {
		const wrapper = await mountSuspended(SiteConfigDiff, {
			props: { rows: [{ key: 'A', label: 'Warm Interval', before: null, after: 30000 }] }
		});
		expect(wrapper.text()).toContain('Warm Interval');
		expect(wrapper.text()).toContain('Default');
		expect(wrapper.text()).toContain('30000');
		expect(wrapper.text()).not.toContain('On the Site Now');
	});

	it('adds the value on the site now when it changed, naming a setting nobody else touched', async () => {
		const wrapper = await mountSuspended(SiteConfigDiff, {
			props: {
				rows: [
					{ key: 'A', label: 'Warm Interval', before: 8000, after: 30000, theirs: 12000 },
					{ key: 'B', label: 'Spool', before: '1', after: '0' }
				]
			}
		});
		expect(wrapper.text()).toContain('On the Site Now');
		expect(wrapper.text()).toContain('12000');
		expect(wrapper.text()).toContain('Same as before');
	});
});

describe('site config form', () => {
	it('keeps Review disabled until a valid change exists and shows the error on a bad value', async () => {
		const wrapper = await mountSuspended(SiteConfigForm, { props: formProps([editable()]) });
		expect(wrapper.text()).not.toContain('Your Changes');

		await wrapper.get('input').setValue('5');
		await wrapper.get('input').trigger('blur');
		await vi.waitFor(() => expect(wrapper.find('[role="alert"]').exists()).toBe(true));
		expect(buttonOf(wrapper, 'Review Changes')!.attributes('disabled')).toBeDefined();

		await wrapper.get('input').setValue('30000');
		await vi.waitFor(() => expect(wrapper.find('[role="alert"]').exists()).toBe(false));
		expect(buttonOf(wrapper, 'Review Changes')!.attributes('disabled')).toBeUndefined();
	});

	it('shows the diff before applying and sends the etag with the changes', async () => {
		cleanup = registerApi({ [`PUT ${SETTINGS}`]: { status: 202, body: { id: 'op_1' } } });
		const wrapper = await mountSuspended(SiteConfigForm, { props: formProps([editable()]) });
		await wrapper.get('input').setValue('30000');
		await buttonOf(wrapper, 'Review Changes')!.trigger('click');

		expect(wrapper.text()).toContain('Before');
		expect(wrapper.text()).toContain('30000');
		await buttonOf(wrapper, 'Apply Changes')!.trigger('click');

		await vi.waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
		expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
			etag: '"tag1"',
			changes: [{ key: 'WARM_INTERVAL_MS', value: 30000 }]
		});
	});

	it('discards the changes and goes back to the saved values', async () => {
		const wrapper = await mountSuspended(SiteConfigForm, { props: formProps([editable()]) });
		await wrapper.get('input').setValue('30000');
		await buttonOf(wrapper, 'Discard Changes')!.trigger('click');
		expect(wrapper.text()).not.toContain('Your Changes');
	});

	it('needs a confirmation naming the setting before a danger setting applies', async () => {
		cleanup = registerApi({ [`PUT ${SETTINGS}`]: { status: 202, body: { id: 'op_1' } } });
		const danger = editable({
			key: 'CSP_MODE',
			label: 'Content Security Policy',
			danger: true,
			description: 'A wrong policy blocks embeds.',
			widget: 'text',
			schema: { type: 'string' }
		});
		const wrapper = await mountSuspended(SiteConfigForm, { props: formProps([danger]) });
		await wrapper.get('input').setValue('enforce');
		await buttonOf(wrapper, 'Review Changes')!.trigger('click');

		expect(wrapper.text()).toContain('I understand what changing Content Security Policy does');
		expect(wrapper.text()).toContain('A wrong policy blocks embeds.');
		expect(buttonOf(wrapper, 'Apply Changes')!.attributes('disabled')).toBeDefined();
		await wrapper.get('[role="checkbox"]').trigger('click');
		await vi.waitFor(() =>
			expect(buttonOf(wrapper, 'Apply Changes')!.attributes('disabled')).toBeUndefined()
		);
	});

	it('shows a three-way diff on a conflict and sends the new etag when the person keeps their change', async () => {
		let attempt = 0;
		cleanup = registerApi({
			[`PUT ${SETTINGS}`]: () => {
				attempt += 1;
				return attempt === 1
					? {
							status: 409,
							body: {
								code: 'conflict',
								message:
									'These settings changed on the site after you opened them.',
								details: { etag: '"tag2"', current: { WARM_INTERVAL_MS: 12000 } },
								requestId: 'req_1'
							}
						}
					: { status: 202, body: { id: 'op_1' } };
			}
		});
		const wrapper = await mountSuspended(SiteConfigForm, { props: formProps([editable()]) });
		await wrapper.get('input').setValue('30000');
		await buttonOf(wrapper, 'Review Changes')!.trigger('click');
		await buttonOf(wrapper, 'Apply Changes')!.trigger('click');

		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('The Site Changed Since You Opened This Page')
		);
		expect(wrapper.text()).toContain('On the Site Now');
		expect(wrapper.text()).toContain('12000');

		await buttonOf(wrapper, 'Keep My Changes')!.trigger('click');
		await vi.waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
		expect((calls.filter((c) => c.method === 'PUT')[1]?.body as { etag: string }).etag).toBe(
			'"tag2"'
		);
	});

	it('asks the page to read again when the person takes the site values', async () => {
		cleanup = registerApi({
			[`PUT ${SETTINGS}`]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'Changed.',
					details: { etag: '"tag2"', current: { WARM_INTERVAL_MS: 12000 } },
					requestId: 'req_1'
				}
			}
		});
		const wrapper = await mountSuspended(SiteConfigForm, { props: formProps([editable()]) });
		await wrapper.get('input').setValue('30000');
		await buttonOf(wrapper, 'Review Changes')!.trigger('click');
		await buttonOf(wrapper, 'Apply Changes')!.trigger('click');
		await vi.waitFor(() => expect(buttonOf(wrapper, 'Use the Site Values')).toBeDefined());
		await buttonOf(wrapper, 'Use the Site Values')!.trigger('click');
		expect(wrapper.emitted('refresh')).toHaveLength(1);
		expect(wrapper.text()).not.toContain('The Site Changed');
	});

	it('shows the failure message when the change cannot start', async () => {
		cleanup = registerApi({
			[`PUT ${SETTINGS}`]: {
				status: 422,
				body: {
					code: 'unprocessable',
					message: 'The site did not answer, so nothing was changed.',
					details: {},
					requestId: 'req_1'
				}
			}
		});
		const wrapper = await mountSuspended(SiteConfigForm, { props: formProps([editable()]) });
		await wrapper.get('input').setValue('30000');
		await buttonOf(wrapper, 'Review Changes')!.trigger('click');
		await buttonOf(wrapper, 'Apply Changes')!.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('The site did not answer, so nothing was changed.')
		);
	});
});

describe('site config history', () => {
	const change = (over: Record<string, unknown> = {}) => ({
		id: 'cfg_1',
		operationId: 'op_1',
		key: 'SPOOL',
		label: 'Spool',
		before: '1',
		after: '0',
		actor: 'user:u',
		status: 'applied',
		createdAt: '2026-11-13T10:00:00.000Z',
		reverted: false,
		revertable: true,
		...over
	});
	const mountHistory = () =>
		mountSuspended(SiteConfigHistory, { props: { orgId: 'org_1', siteId: 'site_1' } });

	it('lists each change with its status in words and a Revert button where it can be reverted', async () => {
		cleanup = registerApi({
			[`GET ${SETTINGS}/history`]: {
				body: {
					items: [
						change(),
						change({ id: 'cfg_2', reverted: true, revertable: false }),
						change({ id: 'cfg_3', status: 'unverified', revertable: false }),
						change({ id: 'cfg_4', status: 'failed', before: null, revertable: false })
					]
				}
			}
		});
		const wrapper = await mountHistory();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Spool'));
		expect(wrapper.text()).toContain('1 to 0');
		expect(wrapper.text()).toContain('Reverted');
		expect(wrapper.text()).toContain('Not Confirmed by the Site');
		expect(wrapper.text()).toContain('Did Not Apply');
		expect(wrapper.text()).toContain('Default to 0');
		expect(wrapper.findAll('button').filter((b) => b.text() === 'Revert')).toHaveLength(1);
	});

	it('starts a revert with its own key', async () => {
		cleanup = registerApi({
			[`GET ${SETTINGS}/history`]: { body: { items: [change()] } },
			[`POST ${SETTINGS}/history/cfg_1/revert`]: { status: 202, body: { id: 'op_2' } }
		});
		const wrapper = await mountHistory();
		await vi.waitFor(() => expect(buttonOf(wrapper, 'Revert')).toBeDefined());
		await buttonOf(wrapper, 'Revert')!.trigger('click');
		await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
		expect(calls.find((c) => c.method === 'POST')?.headers['idempotency-key']).toBeTruthy();
	});

	it('shows the reason when a revert is refused', async () => {
		cleanup = registerApi({
			[`GET ${SETTINGS}/history`]: { body: { items: [change()] } },
			[`POST ${SETTINGS}/history/cfg_1/revert`]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'This change was already reverted.',
					details: {},
					requestId: 'req_1'
				}
			}
		});
		const wrapper = await mountHistory();
		await vi.waitFor(() => expect(buttonOf(wrapper, 'Revert')).toBeDefined());
		await buttonOf(wrapper, 'Revert')!.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('This change was already reverted.')
		);
	});

	it('shows an empty state, a loading state and an error with a retry', async () => {
		cleanup = registerApi({ [`GET ${SETTINGS}/history`]: { body: { items: [] } } });
		const empty = await mountHistory();
		await vi.waitFor(() => expect(empty.text()).toContain('No Changes Yet'));
		cleanup();

		clearBrowserState();
		useSiteConfigStore().reset();
		cleanup = registerApi({
			[`GET ${SETTINGS}/history`]: {
				status: 500,
				body: {
					code: 'internal',
					message: 'The history could not be read.',
					details: {},
					requestId: 'r'
				}
			}
		});
		const broken = await mountHistory();
		await vi.waitFor(() => expect(broken.text()).toContain('Could Not Load the History'));
		expect(buttonOf(broken, 'Try Again')).toBeDefined();
	});

	it('shows loading until the list arrives', async () => {
		cleanup = registerApi({ [`GET ${SETTINGS}/history`]: () => new Promise(() => undefined) });
		const wrapper = await mountHistory();
		expect(wrapper.text()).toContain('Loading History');
	});
});
