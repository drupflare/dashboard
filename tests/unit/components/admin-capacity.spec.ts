import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminCapacity from '~/components/admin/Capacity.vue';
import type { CapacityView } from '~/shared/capacity';
import { calls, clearBrowserState, failure, registerApi } from '../stores/store-support';

const PATH = '/api/v1/admin/capacity';
const NOW = Date.UTC(2026, 10, 12, 12, 30, 15);

const view = (over: Partial<CapacityView> = {}): CapacityView => ({
	generatedAt: NOW,
	credits: {
		state: 'ok',
		currency: 'USD',
		balanceCents: 999_958,
		originalCents: 1_000_000,
		usedCents: 42,
		daysRemaining: 363,
		validFrom: '2026-11-12T00:00:00Z',
		validTo: '2027-11-12T00:00:00Z',
		projectedDepletion: null
	},
	usage: {
		state: 'ok',
		currency: 'USD',
		from: '2026-11-01',
		through: '2026-11-12',
		totalCents: 1250,
		services: [
			{ name: 'Workers', cents: 1000 },
			{ name: 'R2', cents: 250 }
		]
	},
	headroom: {
		state: 'ok',
		kvNamespaces: 3,
		kvLimit: 1000,
		buckets: 2,
		scripts: 7,
		databases: null,
		rate: { remaining: 1100, quota: 1200, resetSeconds: 250, windowSeconds: 300 }
	},
	work: {
		running: 1,
		failedLastDay: 1,
		sites: { active: 4, failed: 1 },
		recentFailures: [
			{
				id: 'op_1',
				type: 'site.upgrade',
				siteId: 'site_1',
				reason: 'Stopped while checking that the site answers.',
				at: NOW - 60_000
			}
		]
	},
	...over
});

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	vi.useRealTimers();
});

async function mountWith(body: CapacityView) {
	cleanup = registerApi({ [`GET ${PATH}`]: { body } });
	const wrapper = await mountSuspended(AdminCapacity);
	mounted.push(wrapper);
	await vi.waitFor(() => expect(wrapper.text()).toContain('Credit Grant'));
	return wrapper;
}

describe('the capacity view', () => {
	it('shows a loading state until the first answer arrives', async () => {
		cleanup = registerApi({
			[`GET ${PATH}`]: async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				return { body: view() };
			}
		});
		const wrapper = await mountSuspended(AdminCapacity);
		mounted.push(wrapper);
		expect(wrapper.find('[role="status"]').text()).toBe('Loading capacity');
		expect(wrapper.find('[role="status"]').findAll('.animate-pulse').length).toBeGreaterThan(3);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Credit Grant'));
		expect(wrapper.text()).not.toContain('Loading capacity');
	});

	it('shows the grant in dollars and plain words', async () => {
		const wrapper = await mountWith(view());
		const text = wrapper.text();
		expect(text).toContain('$9,999.58');
		expect(text).toContain('$10,000.00');
		expect(text).toContain('$0.42 (under 0.01 percent)');
		expect(text).toContain('363');
		expect(text).toContain('2027-11-12');
		expect(text).toContain('None projected');
		expect(text).toContain('Updated 12:30:15 UTC');
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
	});

	it('shows usage by service as a table, with the cost as plain numbers', async () => {
		const wrapper = await mountWith(view());
		const rows = wrapper.findAll('table')[0]?.findAll('tbody tr') ?? [];
		expect(rows.map((row) => row.text())).toEqual(['Workers$10.00', 'R2$2.50']);
		expect(wrapper.text()).toContain('2026-11-01 to 2026-11-12');
		expect(wrapper.text()).toContain('Total $12.50');
	});

	it('names the services past the top eight without listing them', async () => {
		const services = Array.from({ length: 10 }, (_, n) => ({
			name: `Service ${n}`,
			cents: 100 - n
		}));
		const wrapper = await mountWith(
			view({
				usage: {
					state: 'ok',
					currency: 'USD',
					from: null,
					through: null,
					totalCents: 955,
					services
				}
			})
		);
		expect(wrapper.findAll('table')[0]?.findAll('tbody tr')).toHaveLength(8);
		expect(wrapper.text()).toContain('and 2 more services');
	});

	it('shows the headroom and the work in flight', async () => {
		const wrapper = await mountWith(view());
		const text = wrapper.text();
		expect(text).toContain('3 of 1,000');
		expect(text).toContain('1,100 of 1,200');
		expect(text).toContain('250 seconds');
		expect(text).toMatch(/Worker Scripts\s*7/);
		expect(text).toMatch(/D1 Databases\s*Unknown/);
		expect(text).toContain('Running Now');
		expect(text).toContain('Update');
		expect(text).toContain('Stopped while checking that the site answers.');
		expect(text).toContain('2026-11-12 12:29');
	});

	it('says plainly that the token has no billing access and keeps the rest working', async () => {
		const wrapper = await mountWith(view({ credits: { state: 'no_billing_access' } }));
		expect(wrapper.text()).toContain('The token has no billing access.');
		expect(wrapper.text()).toContain('3 of 1,000');
		expect(wrapper.text()).toContain('R2');
	});

	it('shows Usage Detail Is Unavailable while the credits keep working', async () => {
		const wrapper = await mountWith(view({ usage: { state: 'unavailable' } }));
		expect(wrapper.text()).toContain('Usage Detail Is Unavailable');
		expect(wrapper.text()).toContain('$9,999.58');
	});

	it('explains each section that has no credentials, no record or no answer', async () => {
		const wrapper = await mountWith(
			view({
				credits: { state: 'none' },
				usage: { state: 'not_configured' },
				headroom: { state: 'unavailable' }
			})
		);
		const text = wrapper.text();
		expect(text).toContain('no credit grant on record');
		expect(text).toContain('no Cloudflare credentials yet, so it cannot read usage');
		expect(text).toContain('Account headroom could not be read');
	});

	it('shows empty states for no usage, no sites and no failures', async () => {
		const wrapper = await mountWith(
			view({
				usage: {
					state: 'ok',
					currency: null,
					from: null,
					through: null,
					totalCents: 0,
					services: []
				},
				work: { running: 0, failedLastDay: 0, sites: {}, recentFailures: [] }
			})
		);
		const text = wrapper.text();
		expect(text).toContain('No usage is recorded for this billing period yet.');
		expect(text).toContain('No sites yet.');
		expect(text).toContain('No changes failed in the last 24 hours.');
	});

	it('warns when the namespaces pass 80 percent, the grant ends within 30 days and it runs out early', async () => {
		const base = view();
		if (base.credits.state !== 'ok' || base.headroom.state !== 'ok') throw new Error('fixture');
		const wrapper = await mountWith(
			view({
				credits: {
					...base.credits,
					daysRemaining: 12,
					projectedDepletion: '2026-11-20T00:00:00Z'
				},
				headroom: { ...base.headroom, kvNamespaces: 850 }
			})
		);
		const alert = wrapper.find('[role="alert"]');
		expect(alert.text()).toContain('Storage Namespaces Are Filling Up');
		expect(alert.text()).toContain('850 of 1,000');
		expect(alert.text()).toContain('Credit Grant Ends Soon');
		expect(alert.text()).toContain('The grant ends in 12 days on 2027-11-12.');
		expect(alert.text()).toContain('Credit Will Run Out Early');
	});

	it('shows an error state with the server message and loads again on Try Again', async () => {
		let answers = 0;
		cleanup = registerApi({
			[`GET ${PATH}`]: () => {
				answers++;
				// the client retries a failed read once, so the first two answers fail
				return answers <= 2
					? failure('internal', 'Something went wrong.', 'req_1')
					: { body: view() };
			}
		});
		const wrapper = await mountSuspended(AdminCapacity);
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Capacity'));
		expect(wrapper.find('[role="alert"]').text()).toContain('Something went wrong.');
		const retry = wrapper.findAll('button').find((button) => button.text() === 'Try Again');
		await retry?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Credit Grant'));
		expect(wrapper.text()).not.toContain('Could Not Load Capacity');
	});

	it('refreshes once a minute and keeps the numbers when a refresh fails', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		let answers = 0;
		cleanup = registerApi({
			[`GET ${PATH}`]: () => {
				answers++;
				return answers === 1
					? { body: view() }
					: failure('internal', 'Something went wrong.', 'req_2');
			}
		});
		const wrapper = await mountSuspended(AdminCapacity);
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Credit Grant'));
		expect(calls.filter((call) => call.path === PATH)).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(59_000);
		expect(calls.filter((call) => call.path === PATH)).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(wrapper.text()).toContain('The last refresh failed'));
		expect(calls.filter((call) => call.path === PATH).length).toBeGreaterThan(1);
		expect(wrapper.text()).toContain('$9,999.58');
	});
});
