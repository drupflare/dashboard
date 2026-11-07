import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HealthTree from '~/components/health/Tree.vue';
import HealthTreeNode from '~/components/health/tree/Node.vue';
import HealthVerdict from '~/components/health/Verdict.vue';
import ReadinessChecklist from '~/components/readiness/Checklist.vue';
import { HEALTH_STATUSES } from '~/shared/health/view';
import {
	useHealthStore,
	type HealthLeafView,
	type HealthNodeView,
	type SiteHealth
} from '~/stores/health';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

const PATH = '/api/v1/orgs/org_1/sites/site_1/health';

const node = (over: Partial<HealthNodeView> = {}): HealthNodeView => ({
	id: 'supervisor.memory.trend_rising',
	source: 'supervisor',
	level: 'warn',
	state: 'warn',
	title: 'memory.trend_rising',
	detail: 'memory rose across four samples',
	handle: 'interpreter-recycle',
	history: [],
	guidance: {
		text: 'The site repairs this on its own once it is safe to.',
		diagnostics: [{ label: 'Repair handle', value: 'interpreter-recycle' }]
	},
	children: [],
	...over
});

const leaf = (over: Partial<HealthLeafView> = {}): HealthLeafView => ({
	...node(over as Partial<HealthNodeView>),
	children: []
});

const read = (over: Partial<SiteHealth> = {}): SiteHealth => ({
	status: 'healthy',
	level: 'ok',
	reachable: true,
	reason: null,
	step: null,
	nodes: [],
	readiness: {
		level: 'live',
		missing: ['admin access verified', 'a custom domain verified'],
		checks: [
			{ label: 'the site responds', tier: 'live', state: 'done' },
			{ label: 'admin access verified', tier: 'verified', state: 'not-checked' },
			{ label: 'a backup restored in a test', tier: 'production-ready', state: 'open' }
		]
	},
	observedAt: '2026-11-07T12:00:00.000Z',
	...over
});

const LEVELS = [
	['ok', 'OK', 'circle-check'],
	['info', 'Info', 'lucide:info'],
	['warn', 'Warning', 'triangle-alert'],
	['error', 'Error', 'circle-x'],
	['critical', 'Critical', 'octagon-alert']
] as const;

let cleanup: () => void = () => undefined;
let reply: () => Reply;
const mounted: { unmount: () => void }[] = [];

async function mountIt(...args: Parameters<typeof mountSuspended>) {
	const wrapper = await mountSuspended(...args);
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useHealthStore().reset();
	reply = () => ({ body: read() });
	cleanup = registerApi({ [`GET ${PATH}`]: () => reply() });
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('health verdict', () => {
	const cases = [
		['healthy', 'Healthy', 'circle-check'],
		['attention', 'Needs Attention', 'triangle-alert'],
		['starting', 'Starting', 'loader-circle'],
		['unreachable', 'Not Responding', 'circle-x'],
		['unreadable', 'Health Unavailable', 'circle-help']
	] as const;

	it('covers every status the server can send', () => {
		expect(cases.map(([status]) => status)).toEqual([...HEALTH_STATUSES]);
	});

	it.each(cases)('shows %s as an icon and the text %s', async (status, label, icon) => {
		const wrapper = await mountIt(HealthVerdict, { props: { status, level: 'warn' } });

		expect(wrapper.find('[data-test="verdict-label"]').text()).toBe(label);
		expect(wrapper.html()).toContain(icon);
	});

	it('announces nothing at first and the new verdict when it changes', async () => {
		const wrapper = await mountIt(HealthVerdict, {
			props: { status: 'healthy', level: 'ok' }
		});
		const region = () => wrapper.find('[data-test="verdict-announcement"]');

		expect(region().attributes('aria-live')).toBe('polite');
		expect(region().attributes('role')).toBe('status');
		expect(region().text()).toBe('');
		await wrapper.setProps({ status: 'unreachable', level: 'error' } as never);
		expect(region().text()).toBe('Site health changed to Not Responding.');
		await wrapper.setProps({ status: 'healthy', level: 'ok' } as never);
		expect(region().text()).toBe('Site health changed to Healthy.');
	});
});

describe('health node', () => {
	it.each(LEVELS)('shows level %s as an icon and the text %s', async (level, label, icon) => {
		const wrapper = await mountIt(HealthTreeNode, { props: { node: node({ level }) } });
		const badge = wrapper.find('[data-test="node-level"]');

		expect(badge.text()).toBe(label);
		expect(badge.html()).toContain(icon);
		expect(badge.find('[aria-hidden="true"]').exists()).toBe(true);
	});

	it('shows the detail and what happens next in words, with the jargon folded away', async () => {
		const wrapper = await mountIt(HealthTreeNode, { props: { node: node() } });

		expect(wrapper.text()).toContain('memory rose across four samples');
		expect(wrapper.text()).toContain(
			'What happens next: The site repairs this on its own once it is safe to.'
		);
		const details = wrapper.find('details');
		expect(details.exists()).toBe(true);
		expect(details.attributes('open')).toBeUndefined();
		expect(details.find('summary').text()).toBe('Diagnostics');
		expect(details.text()).toContain('interpreter-recycle');
		expect(wrapper.find('li').text().replace(details.text(), '')).not.toContain(
			'interpreter-recycle'
		);
	});

	it('lists the history newest first and keeps the last five', async () => {
		const history = [1, 2, 3, 4, 5, 6].map((minute) => ({
			state: `state${minute}`,
			atMs: Date.UTC(2026, 10, 7, 12, minute)
		}));
		const wrapper = await mountIt(HealthTreeNode, { props: { node: node({ history }) } });
		const items = wrapper.findAll('li li').map((item) => item.text());

		expect(items).toEqual([
			'state6 at 2026-11-07 12:06 UTC',
			'state5 at 2026-11-07 12:05 UTC',
			'state4 at 2026-11-07 12:04 UTC',
			'state3 at 2026-11-07 12:03 UTC',
			'state2 at 2026-11-07 12:02 UTC'
		]);
	});

	it('collapses its children from a labelled button that reports its state', async () => {
		const parent = node({
			id: 'reconcile',
			title: 'Reconciliation',
			guidance: null,
			children: [leaf({ id: 'reconcile.step', title: 'Owner tiers' })]
		});
		const wrapper = await mountIt(HealthTreeNode, { props: { node: parent } });
		const button = wrapper.find('button');
		const child = () => wrapper.find('ul');

		expect(button.attributes('aria-expanded')).toBe('true');
		expect(button.attributes('aria-controls')).toBe(child().attributes('id'));
		expect(button.text()).toContain('Reconciliation');
		const hidden = () => child().attributes('style') ?? '';
		expect(hidden()).not.toContain('display: none');
		await button.trigger('click');
		expect(button.attributes('aria-expanded')).toBe('false');
		expect(hidden()).toContain('display: none');
		await button.trigger('click');
		expect(hidden()).not.toContain('display: none');
	});

	it('starts collapsed when nothing under it needs a look', async () => {
		const parent = node({
			level: 'ok',
			guidance: null,
			children: [leaf({ level: 'ok', guidance: null })]
		});
		const wrapper = await mountIt(HealthTreeNode, { props: { node: parent } });

		expect(wrapper.find('button').attributes('aria-expanded')).toBe('false');
	});
});

describe('health tree', () => {
	const props = { orgId: 'org_1', siteId: 'site_1' };

	it('shows a loading line, then the verdict and when it was read', async () => {
		const wrapper = await mountIt(HealthTree, { props });

		await vi.waitFor(() =>
			expect(wrapper.find('[data-test="verdict-label"]').text()).toBe('Healthy')
		);
		expect(wrapper.text()).toContain('Last checked 2026-11-07 12:00 UTC');
	});

	it('says Nothing to Fix for a healthy tree with no problem nodes', async () => {
		reply = () => ({ body: read({ nodes: [node({ level: 'ok', guidance: null })] }) });
		const wrapper = await mountIt(HealthTree, { props });

		await vi.waitFor(() => expect(wrapper.text()).toContain('Nothing to Fix'));
		expect(wrapper.find('button').exists()).toBe(false);
	});

	it('lists the nodes and says Needs Attention when a finding needs a look', async () => {
		reply = () => ({
			body: read({ status: 'attention', level: 'warn', nodes: [node()] })
		});
		const wrapper = await mountIt(HealthTree, { props });

		await vi.waitFor(() =>
			expect(wrapper.find('[data-test="verdict-label"]').text()).toBe('Needs Attention')
		);
		expect(wrapper.text()).toContain('memory.trend_rising');
		expect(wrapper.text()).not.toContain('Nothing to Fix');
	});

	it('says Not Responding with the reason and no tree', async () => {
		reply = () => ({
			body: read({
				status: 'unreachable',
				level: 'error',
				reachable: false,
				reason: 'The site did not answer.'
			})
		});
		const wrapper = await mountIt(HealthTree, { props });

		await vi.waitFor(() =>
			expect(wrapper.find('[data-test="verdict-label"]').text()).toBe('Not Responding')
		);
		expect(wrapper.find('[data-test="reason"]').text()).toBe('The site did not answer.');
		expect(wrapper.find('li').exists()).toBe(false);
	});

	it('says Starting with the step the site names', async () => {
		reply = () => ({
			body: read({
				status: 'starting',
				level: 'info',
				step: 'Unpacking the database, part 3 of 12'
			})
		});
		const wrapper = await mountIt(HealthTree, { props });

		await vi.waitFor(() =>
			expect(wrapper.find('[data-test="verdict-label"]').text()).toBe('Starting')
		);
		expect(wrapper.find('[data-test="step"]').text()).toBe(
			'Unpacking the database, part 3 of 12'
		);
	});

	it('says why a health read could not be made at all', async () => {
		reply = () => failure('internal', 'Something went wrong on our side.', 'req_9');
		const wrapper = await mountIt(HealthTree, { props });

		await vi.waitFor(() => expect(wrapper.text()).toContain('Health Unavailable'));
		expect(wrapper.text()).toContain('Something went wrong on our side.');
		expect(wrapper.text()).toContain('req_9');
	});

	it('promises no repair button', async () => {
		reply = () => ({
			body: read({ status: 'attention', level: 'warn', nodes: [node()] })
		});
		const wrapper = await mountIt(HealthTree, { props });

		await vi.waitFor(() => expect(wrapper.text()).toContain('memory.trend_rising'));
		expect(wrapper.text()).not.toMatch(/\b(repair now|fix now|run repair)\b/i);
		expect(wrapper.findAll('button')).toHaveLength(0);
	});

	it('asks once for the tree and the checklist together', async () => {
		const wrapper = await mountIt({
			components: { HealthTree, ReadinessChecklist },
			template:
				'<div><HealthTree v-bind="props" /><ReadinessChecklist v-bind="props" /></div>',
			setup: () => ({ props })
		});

		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Live. Next: admin access verified')
		);
		expect(calls.filter((call) => call.path === PATH)).toHaveLength(1);
	});
});

describe('readiness checklist', () => {
	const props = { orgId: 'org_1', siteId: 'site_1' };

	it('names the level and the next check', async () => {
		const wrapper = await mountIt(ReadinessChecklist, { props });

		await vi.waitFor(() =>
			expect(wrapper.find('[data-test="readiness-summary"]').text()).toBe(
				'Live. Next: admin access verified'
			)
		);
	});

	it.each([
		['pending', ['the site responds'], 'Not Live Yet. Next: the site responds'],
		[
			'verified',
			['a backup restored in a test'],
			'Verified. Next: a backup restored in a test'
		],
		['production-ready', [], 'Production Ready']
	] as const)('reads level %s as %s', async (level, missing, text) => {
		reply = () => ({
			body: read({ readiness: { level, missing: [...missing], checks: [] } })
		});
		const wrapper = await mountIt(ReadinessChecklist, { props });

		await vi.waitFor(() =>
			expect(wrapper.find('[data-test="readiness-summary"]').text()).toBe(text)
		);
	});

	it('shows each check as done, not done or not checked, in icon and text', async () => {
		const wrapper = await mountIt(ReadinessChecklist, { props });

		await vi.waitFor(() =>
			expect(wrapper.findAll('[data-test="check-state"]')).toHaveLength(3)
		);
		const rows = wrapper
			.findAll('li')
			.map(
				(li) => `${li.find('span').text()} ${li.find('[data-test="check-state"]').text()}`
			);
		expect(rows).toEqual([
			'The site responds Done',
			'Admin access verified Not Checked',
			'A backup restored in a test Not Done'
		]);
		const html = wrapper.findAll('[data-test="check-state"]').map((state) => state.html());
		expect(html[0]).toContain('circle-check');
		expect(html[1]).toContain('circle-help');
		expect(html[2]).toContain('circle-dashed');
	});

	it('groups the checks under their level', async () => {
		const wrapper = await mountIt(ReadinessChecklist, { props });

		await vi.waitFor(() => expect(wrapper.findAll('h3')).toHaveLength(3));
		expect(wrapper.findAll('h3').map((h) => h.text())).toEqual([
			'Live',
			'Verified',
			'Production Ready'
		]);
	});
});
