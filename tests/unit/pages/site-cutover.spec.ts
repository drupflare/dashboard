import { mountSuspended } from '@nuxt/test-utils/runtime';
import type { DOMWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SiteCutoverBoundary from '~/components/site/cutover/Boundary.vue';
import SiteCutoverPlan from '~/components/site/cutover/Plan.vue';
import SiteCutoverWindow from '~/components/site/cutover/Window.vue';
import CutoverPage from '~/pages/sites/[id]/cutover.vue';
import { CHOICE_COPY, POLICY_COPY } from '~/shared/cutover-copy';
import { ROLLBACK_BOUNDARY_COPY } from '~/shared/operation-copy';
import { useCutoverStore, type CutoverPayload, type CutoverView } from '~/stores/cutover';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi, type Reply } from '../stores/store-support';

const ORG = 'org_personal';
const SITE = 'site_1';
const base = `/api/v1/orgs/${ORG}/sites/${SITE}/cutover`;
const soon = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();

const site = {
	id: SITE,
	orgId: ORG,
	name: 'campus-site',
	kind: 'drupal',
	category: 'cms',
	plane: 'managed',
	config: 'managed',
	accountId: null,
	state: 'active',
	ring: 'R1',
	primaryHostname: 'campus-site.drupflare.app',
	hostnames: [],
	admin: { username: 'admin', email: 'owner@example.test', password: 'available' },
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z'
};

const STEPS = [
	'lease',
	'lower-ttl',
	'snapshot',
	'capture-delta',
	'validate',
	'owner-approval',
	'apply-write-policy',
	'final-delta',
	'promote',
	'route',
	'observe-5m',
	'observe-30m',
	'observe-6h',
	'observe-24h'
];

function view(over: Partial<CutoverView> = {}): CutoverView {
	return {
		operationId: 'op_1',
		siteId: SITE,
		policy: 'freeze',
		state: 'running',
		step: 'snapshot',
		expectedWindowSeconds: 180,
		destinationWrites: 0,
		choice: null,
		boundary: 'dns-reversal',
		needsChoice: false,
		observed: 0,
		lastHealthy: null,
		exportReference: null,
		cannotCarry: [],
		refusal: null,
		reason: null,
		sourceDestroyed: false,
		updatedAt: null,
		steps: STEPS.map((id) => ({ id, name: id, state: 'pending' as const })),
		...over
	};
}

function plan(over: Partial<CutoverPayload> = {}): CutoverPayload {
	return {
		ready: true,
		available: true,
		policies: [
			{ policy: 'freeze', expectedWindowSeconds: 180 },
			{ policy: 'read-only', expectedWindowSeconds: 180 },
			{ policy: 'delta', expectedWindowSeconds: 120 }
		],
		observationOffsetsMs: [300_000, 1_800_000, 21_600_000, 86_400_000],
		ttlSeconds: 60,
		cutover: null,
		...over
	};
}

const me = (stepUpUntil: string | null) => ({
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session' as const,
	stepUpUntil
});

let cleanup: () => void = () => undefined;
let planReply: () => Reply;
let siteReply: () => Reply;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useCutoverStore().$reset();
	useSessionStore().me = me(soon());
	planReply = () => ({ body: plan() });
	siteReply = () => ({ body: site });
	cleanup = registerApi({
		'GET /api/v1/me': { body: me(soon()) },
		[`GET /api/v1/sites/${SITE}`]: () => siteReply(),
		[`GET ${base}`]: () => planReply(),
		[`POST ${base}`]: { status: 202, body: {} },
		[`POST ${base}/approve`]: { status: 202, body: {} },
		[`POST ${base}/choice`]: { status: 202, body: {} }
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(CutoverPage, { route: `/sites/${SITE}/cutover` });
	mounted.push(wrapper);
	return wrapper;
}

const button = (wrapper: { findAll: (selector: string) => DOMWrapper<Element>[] }, text: string) =>
	wrapper.findAll('button').find((candidate) => candidate.text() === text);

describe('window component', () => {
	it('states what the policy does and how long the window is', async () => {
		const wrapper = await mountSuspended(SiteCutoverWindow, {
			props: { policy: 'freeze', seconds: 180 }
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain(POLICY_COPY.freeze.consequence);
		expect(wrapper.get('[data-test="window"]').text()).toBe(
			'Expect about 3 minutes when your old site cannot take changes.'
		);
	});

	it('uses a different sentence for the delta policy and says when the window is unknown', async () => {
		const delta = await mountSuspended(SiteCutoverWindow, {
			props: { policy: 'delta', seconds: 30 }
		});
		mounted.push(delta);
		expect(delta.get('[data-test="window"]').text()).toContain('30 seconds');
		expect(delta.get('[data-test="window"]').text()).toContain('last changes are copied');
		const unknown = await mountSuspended(SiteCutoverWindow, {
			props: { policy: 'freeze', seconds: null }
		});
		mounted.push(unknown);
		expect(unknown.get('[data-test="window"]').text()).toContain('not known yet');
	});
});

describe('plan component', () => {
	it('shows the consequence of every policy in plain words', async () => {
		const wrapper = await mountSuspended(SiteCutoverPlan, {
			props: { plan: plan(), busy: false, error: null }
		});
		mounted.push(wrapper);
		for (const copy of Object.values(POLICY_COPY)) {
			expect(wrapper.text()).toContain(copy.label);
			expect(wrapper.text()).toContain(copy.consequence);
		}
	});

	it('keeps Start the Move disabled until the reference and the address are filled in', async () => {
		const wrapper = await mountSuspended(SiteCutoverPlan, {
			props: { plan: plan(), busy: false, error: null }
		});
		mounted.push(wrapper);
		const start = () => button(wrapper, 'Start the Move')!;
		expect(start().attributes('disabled')).toBeDefined();
		await wrapper.get('input[name="source"]').setValue('source-1');
		await wrapper.get('input[name="hostname"]').setValue('WWW.Example.Edu');
		expect(start().attributes('disabled')).toBeUndefined();
		await wrapper.get('form').trigger('submit');
		expect(wrapper.emitted('start')).toEqual([
			[{ policy: 'freeze', source: { ref: 'source-1' }, hostname: 'www.example.edu' }]
		]);
	});

	it('lists what the owner does by hand and names the address once it is typed', async () => {
		const wrapper = await mountSuspended(SiteCutoverPlan, {
			props: { plan: plan(), busy: false, error: null }
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('What You Do by Hand');
		expect(wrapper.text()).toContain('Point your address at the new site');
		await wrapper.get('input[name="hostname"]').setValue('www.example.edu');
		expect(wrapper.text()).toContain(
			'Set the cache time (TTL) of www.example.edu to 60 seconds'
		);
		expect(wrapper.findAll('li')).toHaveLength(4);
	});

	it('shows the refusal it is given', async () => {
		const wrapper = await mountSuspended(SiteCutoverPlan, {
			props: { plan: plan(), busy: false, error: 'Another change is running.' }
		});
		mounted.push(wrapper);
		expect(wrapper.get('[role="alert"]').text()).toBe('Another change is running.');
	});
});

describe('boundary component', () => {
	const props = (v: CutoverView) => ({ view: v, busy: false });

	it('marks the boundary after the route step and says going back is a DNS change', async () => {
		const wrapper = await mountSuspended(SiteCutoverBoundary, {
			props: props(view({ state: 'observing' }))
		});
		mounted.push(wrapper);
		const items = wrapper.findAll('li').map((item) => item.attributes('data-test') ?? '');
		expect(items.indexOf('boundary')).toBe(STEPS.indexOf('route') + 1);
		expect(wrapper.get('[data-test="boundary"]').text()).toBe(
			ROLLBACK_BOUNDARY_COPY['dns-reversal']
		);
		expect(button(wrapper, 'Go Back Now')).toBeDefined();
		expect(wrapper.find('[data-test="choices"]').exists()).toBe(false);
	});

	it('offers the three choices and no reversal after the first write', async () => {
		const wrapper = await mountSuspended(SiteCutoverBoundary, {
			props: props(
				view({
					state: 'observing',
					boundary: 'post-write',
					destinationWrites: 4,
					needsChoice: true
				})
			)
		});
		mounted.push(wrapper);
		expect(wrapper.get('[data-test="boundary"]').text()).toBe(
			ROLLBACK_BOUNDARY_COPY['post-write']
		);
		expect(button(wrapper, 'Go Back Now')).toBeUndefined();
		for (const copy of Object.values(CHOICE_COPY)) {
			expect(button(wrapper, copy.label)).toBeDefined();
		}
		await button(wrapper, CHOICE_COPY['keep-new'].label)!.trigger('click');
		expect(wrapper.emitted('choose')).toEqual([['keep-new']]);
	});

	it('shows the refusal from the move and the choice that was recorded', async () => {
		const wrapper = await mountSuspended(SiteCutoverBoundary, {
			props: props(
				view({
					state: 'observing',
					boundary: 'post-write',
					destinationWrites: 2,
					needsChoice: true,
					refusal: { code: 'reversal_closed', message: 'Going back is closed.' },
					choice: {
						value: 'keep-new',
						writesAtChoice: 2,
						recordedAt: '2026-11-12T10:00:00Z'
					}
				})
			)
		});
		mounted.push(wrapper);
		expect(wrapper.get('[role="alert"]').text()).toBe('Going back is closed.');
		expect(wrapper.text()).toContain('You chose: Keep the New Site.');
		expect(wrapper.find('[data-test="choices"]').exists()).toBe(false);
	});

	it('names the saved export and what it could not carry', async () => {
		const wrapper = await mountSuspended(SiteCutoverBoundary, {
			props: props(
				view({
					state: 'rolled-back',
					boundary: 'post-write',
					exportReference: 'export-9',
					cannotCarry: ['uploaded files']
				})
			)
		});
		mounted.push(wrapper);
		const text = wrapper.get('[data-test="export"]').text();
		expect(text).toContain('saved as export-9');
		expect(text).toContain('uploaded files');
	});

	it('writes each step in plain words, never the step id', async () => {
		const wrapper = await mountSuspended(SiteCutoverBoundary, {
			props: props(view({ step: 'validate' }))
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('Waiting for your approval');
		expect(wrapper.text()).not.toMatch(/owner-approval|apply-write-policy/);
	});
});

describe('cutover page', () => {
	it('shows the plan form for a site with no move', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Start the Move'));
		expect(wrapper.text()).toContain('Move campus-site');
		expect(wrapper.text()).toContain('never deleted');
	});

	it('says a site that is not managed cannot take a move', async () => {
		planReply = () => ({ body: plan({ ready: false }) });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('This Site Cannot Take a Move'));
		expect(wrapper.text()).not.toContain('Start the Move');
	});

	it('says moves are not available yet while the adapters are off', async () => {
		planReply = () => ({ body: plan({ available: false }) });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Moves Are Not Available Yet'));
	});

	it('shows the approval button when the move waits, and sends one approval', async () => {
		planReply = () => ({
			body: plan({ cutover: view({ state: 'awaiting-approval', step: 'owner-approval' }) })
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Approve the Move')).toBeDefined());
		await button(wrapper, 'Approve the Move')!.trigger('click');
		await vi.waitFor(() =>
			expect(calls.filter((call) => call.path.endsWith('/approve'))).toHaveLength(1)
		);
	});

	it('shows the timeline with the observation points while the move is observing', async () => {
		planReply = () => ({
			body: plan({ cutover: view({ state: 'observing', step: 'observe' }) })
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('[data-test="boundary"]').exists()).toBe(true));
		expect(wrapper.text()).toContain('5 minutes, 30 minutes, 6 hours, 24 hours');
		expect(wrapper.text()).not.toContain('Approve the Move');
	});

	it('shows the three choices after the first write and sends the one pressed', async () => {
		planReply = () => ({
			body: plan({
				cutover: view({
					state: 'observing',
					boundary: 'post-write',
					destinationWrites: 3,
					needsChoice: true
				})
			})
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('[data-test="choices"]').exists()).toBe(true));
		await button(wrapper, CHOICE_COPY['export-changes'].label)!.trigger('click');
		await vi.waitFor(() =>
			expect(calls.find((call) => call.path.endsWith('/choice'))?.body).toEqual({
				value: 'export-changes'
			})
		);
	});

	it('shows the plain reason when the move failed', async () => {
		planReply = () => ({
			body: plan({
				cutover: view({
					state: 'failed',
					reason: 'Stopped while checking the new site against the snapshot and the changes.'
				})
			})
		});
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Stopped while checking the new site')
		);
	});

	it('asks for a fresh sign-in before it sends an approval on a stale session', async () => {
		useSessionStore().me = me(null);
		planReply = () => ({
			body: plan({ cutover: view({ state: 'awaiting-approval', step: 'owner-approval' }) })
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Approve the Move')).toBeDefined());
		await button(wrapper, 'Approve the Move')!.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Confirm Your Identity'));
		expect(calls.filter((call) => call.path.endsWith('/approve'))).toHaveLength(0);
	});

	it('says the site is not found for a 404', async () => {
		siteReply = () => ({
			status: 404,
			body: { code: 'not_found', message: 'Not found', details: {} }
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Site Not Found'));
	});
});
