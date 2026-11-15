import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReleaseCard from '~/components/release/Card.vue';
import CohortPicker from '~/components/release/cohort/Picker.vue';
import ReleaseRings from '~/components/release/Rings.vue';
import Rollback from '~/components/site/deploy/Rollback.vue';
import ReleasesPage from '~/pages/admin/releases.vue';
import { plainDuration, plainReason } from '~/shared/rollout-copy';
import { useReleasesStore, type ReleaseView, type RolloutView } from '~/stores/releases';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const rings = (reached: number, over: Partial<Record<string, number>> = {}) =>
	(['R0', 'R1', 'R2', 'R3'] as const).map((ring, index) => ({
		ring,
		reached: index < reached,
		upgraded: index < reached ? 2 : 0,
		failed: 0,
		reverted: 0,
		stuck: 0,
		...over
	}));

const rollout = (over: Partial<RolloutView> = {}): RolloutView => ({
	id: 'op_1',
	releaseId: 'rel-a',
	status: 'rolling',
	currentRing: 'R1',
	rings: rings(2),
	reasons: [],
	stopRequested: false,
	firstRingAt: 1,
	lastRingAt: 2,
	advisoryIntervalMs: null,
	createdAt: 1,
	...over
});

const release = (over: Partial<ReleaseView> = {}): ReleaseView => ({
	id: 'rel-a',
	kind: 'worker',
	version: '2.0.0',
	schemaVersion: 1,
	acceptsSchema: 1,
	publishedAt: Date.UTC(2026, 10, 1),
	advisoryAt: null,
	rollout: null,
	...over
});

const mounted: { unmount: () => void }[] = [];
let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	navigate.mockReset();
	useSessionStore().$reset();
	useReleasesStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mount<T>(component: T, props: Record<string, unknown> = {}) {
	const wrapper = await mountSuspended(component as never, { props: props as never });
	mounted.push(wrapper);
	return wrapper;
}

describe('plain words for a rollout', () => {
	it('turns each recorded reason into a sentence with no internal names', () => {
		expect(plainReason('failureRate is 0.05')).toBe(
			'The share of failed requests is 0.05, which is over the limit.'
		);
		expect(plainReason('no reading for memoryTrend')).toBe(
			'Memory growth was not reported, so the rollout stopped to be safe.'
		);
		expect(plainReason('no reading for syntheticHealthy')).toContain('test site');
		expect(plainReason('the synthetic site is broken')).toBe(
			'The test site stopped answering.'
		);
		expect(plainReason('2 of 6 sites in R3 did not take the release')).toBe(
			'2 of 6 sites in ring 3 did not take the release.'
		);
		expect(plainReason('the sites in R0 did not report in time')).toBe(
			'The sites in ring 0 did not report in time.'
		);
		expect(plainReason('an admin stopped the rollout')).toBe('An admin stopped the rollout.');
		expect(plainReason('something new happened')).toBe('Something new happened.');
	});

	it('writes a duration in the largest units', () => {
		expect(plainDuration(30_000)).toBe('under a minute');
		expect(plainDuration(90 * 60_000)).toBe('1 hour 30 minutes');
		expect(plainDuration(26 * 60 * 60_000)).toBe('1 day 2 hours');
		expect(plainDuration(5 * 60_000)).toBe('5 minutes');
	});
});

describe('the ring list', () => {
	it('marks finished rings, the ring in progress and the rings still waiting, as icon and text', async () => {
		const wrapper = await mount(ReleaseRings, { rollout: rollout() });
		const rows = wrapper.findAll('li').map((row) => row.text());
		expect(rows[0]).toContain('Ring 0');
		expect(rows[0]).toContain('Done');
		expect(rows[1]).toContain('Updating');
		expect(rows[2]).toContain('Waiting');
		expect(rows[3]).toContain('Waiting');
		expect(wrapper.findAll('svg, [class*="i-lucide"]').length).toBeGreaterThan(3);
	});

	it('shows where a halted rollout stopped and what a revert put back', async () => {
		const halted = await mount(ReleaseRings, {
			rollout: rollout({
				status: 'halted',
				currentRing: null,
				rings: rings(2, { failed: 1 })
			})
		});
		expect(halted.findAll('li')[1]?.text()).toContain('Stopped here');
		expect(halted.findAll('li')[1]?.text()).toContain('1 did not take it');
		const reverted = await mount(ReleaseRings, {
			rollout: rollout({
				status: 'reverted',
				currentRing: null,
				rings: rings(2, { reverted: 2, stuck: 1 })
			})
		});
		expect(reverted.findAll('li')[1]?.text()).toContain('Put back');
		expect(reverted.findAll('li')[1]?.text()).toContain('2 put back, 1 could not be put back');
	});

	it('shows every ring done for a finished rollout', async () => {
		const wrapper = await mount(ReleaseRings, {
			rollout: rollout({ status: 'complete', currentRing: null, rings: rings(4) })
		});
		expect(wrapper.findAll('li').every((row) => row.text().includes('Done'))).toBe(true);
	});
});

describe('the release card', () => {
	it('offers Roll Out for a release that has not been rolled out', async () => {
		const wrapper = await mount(ReleaseCard, { release: release() });
		expect(wrapper.text()).toContain('Release 2.0.0');
		expect(wrapper.text()).toContain('This release has not been rolled out.');
		await wrapper.find('button').trigger('click');
		expect(wrapper.emitted('rollOut')?.[0]?.[0]).toMatchObject({ id: 'rel-a' });
	});

	it('shows Stop Rollout instead while a rollout runs, and Stopping once asked', async () => {
		const wrapper = await mount(ReleaseCard, { release: release({ rollout: rollout() }) });
		expect(wrapper.text()).toContain('Rolling Out');
		expect(wrapper.text()).not.toContain('Roll Out\n');
		await wrapper.find('button').trigger('click');
		expect(wrapper.emitted('stop')).toHaveLength(1);
		const asked = await mount(ReleaseCard, {
			release: release({ rollout: rollout({ stopRequested: true }) })
		});
		expect(asked.find('button').text()).toBe('Stopping');
		expect(asked.find('button').attributes('disabled')).toBeDefined();
	});

	it('says why a stopped rollout stopped, in plain words', async () => {
		const wrapper = await mount(ReleaseCard, {
			release: release({
				rollout: rollout({
					status: 'halted',
					currentRing: null,
					reasons: ['failureRate is 0.05', 'no reading for memoryTrend']
				})
			})
		});
		const why = wrapper.find('[aria-label="Why the rollout stopped"]');
		expect(why.text()).toContain('The share of failed requests is 0.05');
		expect(why.text()).toContain('Memory growth was not reported');
		expect(wrapper.text()).not.toContain('failureRate');
	});

	it('shows the interval from the advisory, or says it is not known yet', async () => {
		const known = await mount(ReleaseCard, {
			release: release({
				advisoryAt: 1,
				rollout: rollout({ advisoryIntervalMs: 26 * 60 * 60_000 })
			})
		});
		expect(known.text()).toContain('Time from the advisory to the last ring: 1 day 2 hours.');
		const unknown = await mount(ReleaseCard, {
			release: release({ advisoryAt: 1, rollout: rollout() })
		});
		expect(unknown.text()).toContain('is not known yet');
	});
});

describe('the cohort picker', () => {
	const sites = [
		{ id: 'site_1', name: 'Alpha' },
		{ id: 'site_2', name: 'Beta' }
	];
	const empty = { designations: { synthetic: [], own: [], canary: [] }, overrides: [] };

	it('says so when there are no sites', async () => {
		const wrapper = await mount(CohortPicker, { sites: [], modelValue: empty });
		expect(wrapper.text()).toContain('There are no sites to place.');
	});

	it('emits a role and a ring choice for one site and clears a ring with Automatic', async () => {
		const wrapper = await mount(CohortPicker, { sites, modelValue: empty });
		await wrapper.find('select[aria-label="Role of Alpha"]').setValue('synthetic');
		expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toMatchObject({
			designations: { synthetic: ['site_1'], own: [], canary: [] }
		});
		await wrapper.find('select[aria-label="Ring of Beta"]').setValue('R5');
		expect(wrapper.emitted('update:modelValue')?.[1]?.[0]).toMatchObject({
			overrides: [{ siteId: 'site_2', ring: 'R5' }]
		});
		const placed = await mount(CohortPicker, {
			sites,
			modelValue: { ...empty, overrides: [{ siteId: 'site_2', ring: 'R5' }] }
		});
		await placed.find('select[aria-label="Ring of Beta"]').setValue('auto');
		expect(placed.emitted('update:modelValue')?.[0]?.[0]).toMatchObject({ overrides: [] });
	});

	it('moves a site between roles without leaving it in two', async () => {
		const wrapper = await mount(CohortPicker, {
			sites,
			modelValue: { ...empty, designations: { synthetic: ['site_1'], own: [], canary: [] } }
		});
		await wrapper.find('select[aria-label="Role of Alpha"]').setValue('own');
		expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toMatchObject({
			designations: { synthetic: [], own: ['site_1'], canary: [] }
		});
	});
});

describe('the releases page', () => {
	const admin = () => {
		useSessionStore().me = {
			id: 'usr_1',
			email: 'admin@example.test',
			displayName: null,
			via: 'session',
			stepUpUntil: new Date(Date.now() + 60_000).toISOString(),
			platformRole: 'admin'
		} as never;
	};

	it('shows a loading state, then the releases', async () => {
		admin();
		cleanup = registerApi({
			'GET /api/v1/admin/releases': async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return { body: { releases: [release({ rollout: rollout() })] } };
			}
		});
		const wrapper = await mount(ReleasesPage);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Loading releases'));
		await vi.waitFor(() => expect(wrapper.text()).toContain('Release 2.0.0'));
		expect(wrapper.text()).toContain('Ring 0');
	});

	it('shows an empty state when nothing is registered', async () => {
		admin();
		cleanup = registerApi({ 'GET /api/v1/admin/releases': { body: { releases: [] } } });
		const wrapper = await mount(ReleasesPage);
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Releases Yet'));
	});

	it('shows an error state with a retry', async () => {
		admin();
		let fail = true;
		cleanup = registerApi({
			'GET /api/v1/admin/releases': () =>
				fail
					? {
							status: 500,
							body: {
								code: 'internal',
								message: 'Boom',
								details: {},
								requestId: 'req_9'
							}
						}
					: { body: { releases: [] } }
		});
		const wrapper = await mount(ReleasesPage);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Releases Could Not Load'));
		expect(wrapper.text()).toContain('req_9');
		fail = false;
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Try Again')
			?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Releases Yet'));
	});

	it('says there is nothing here to someone who is not a platform admin', async () => {
		useSessionStore().me = {
			id: 'usr_2',
			email: 'person@example.test',
			displayName: null,
			via: 'session',
			stepUpUntil: null
		} as never;
		cleanup = registerApi({ 'GET /api/v1/admin/releases': { body: { releases: [] } } });
		const wrapper = await mount(ReleasesPage);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Page Not Found'));
	});

	it('starts a rollout only after the version is typed, with one key', async () => {
		admin();
		cleanup = registerApi({
			'GET /api/v1/admin/releases': { body: { releases: [release()] } },
			'GET /api/v1/admin/sites': {
				body: { items: [{ id: 'site_1', name: 'Alpha' }], nextBefore: null }
			},
			'POST /api/v1/admin/releases/rel-a/rollout': { status: 202, body: rollout() }
		});
		const wrapper = await mount(ReleasesPage);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Release 2.0.0'));
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Roll Out')
			?.trigger('click');
		const body = () => document.body;
		await vi.waitFor(() => expect(body().textContent).toContain('Roll Out Release 2.0.0'));
		await vi.waitFor(() => expect(body().textContent).toContain('Alpha'));
		const submit = [...body().querySelectorAll('button')].find(
			(button) => button.textContent?.trim() === 'Roll Out' && button.type === 'submit'
		) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		const input = body().querySelector('input[type="text"]') as HTMLInputElement;
		input.value = '2.0.0';
		input.dispatchEvent(new Event('input'));
		await vi.waitFor(() => expect(submit.disabled).toBe(false));
		submit.click();
		await vi.waitFor(() =>
			expect(calls.filter((call) => call.path.endsWith('/rollout'))).toHaveLength(1)
		);
		const sent = calls.find((call) => call.path.endsWith('/rollout'))!;
		expect(sent.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
		expect(sent.body).toMatchObject({ designations: { synthetic: [] }, overrides: [] });
	});
});

describe('the rollback check on a site', () => {
	const PATH = '/api/v1/orgs/org_a/sites/site_1';

	it('shows the verdict, then asks to confirm and posts with a key', async () => {
		cleanup = registerApi({
			[`GET ${PATH}/rollback-check`]: {
				body: {
					siteId: 'site_1',
					release: 'rel-old',
					allowed: true,
					reason: null,
					offers: []
				}
			},
			[`POST ${PATH}/rollback`]: { status: 202, body: { id: 'op_9' } }
		});
		const wrapper = await mount(Rollback, {
			orgId: 'org_a',
			siteId: 'site_1',
			release: 'rel-old'
		});
		expect(wrapper.text()).toContain('Checking whether the earlier code can run');
		await vi.waitFor(() => expect(wrapper.text()).toContain('The earlier code can run'));
		expect(calls[0]?.query).toMatchObject({ release: 'rel-old' });
		await wrapper.find('button').trigger('click');
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Confirm Roll Back')
			?.trigger('click');
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/new/progress/op_9'));
		const post = calls.find((call) => call.method === 'POST')!;
		expect(post.body).toEqual({ release: 'rel-old' });
		expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('shows the reason and both offers, and no button, when the guard refuses', async () => {
		cleanup = registerApi({
			[`GET ${PATH}/rollback-check`]: {
				body: {
					siteId: 'site_1',
					release: 'rel-old',
					allowed: false,
					reason: 'The current release changed how this site stores its data.',
					offers: ['restore-data-with-code', 'fix-forward']
				}
			}
		});
		const wrapper = await mount(Rollback, {
			orgId: 'org_a',
			siteId: 'site_1',
			release: 'rel-old'
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('cannot go back on its own'));
		expect(wrapper.text()).toContain('changed how this site stores its data');
		expect(wrapper.text()).toContain('Restore the data together with the code');
		expect(wrapper.text()).toContain('Fix the problem in a new release');
		expect(wrapper.findAll('button')).toHaveLength(0);
	});

	it('shows a failed check with a retry, and a failed rollback in place', async () => {
		let answer = 0;
		cleanup = registerApi({
			[`GET ${PATH}/rollback-check`]: () =>
				answer++ === 0
					? {
							status: 404,
							body: {
								code: 'not_found',
								message: 'That release is not registered',
								details: {},
								requestId: 'r'
							}
						}
					: {
							body: {
								siteId: 'site_1',
								release: 'rel-old',
								allowed: true,
								reason: null,
								offers: []
							}
						},
			[`POST ${PATH}/rollback`]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'Another change to this site is still running.',
					details: {},
					requestId: 'r'
				}
			}
		});
		const wrapper = await mount(Rollback, {
			orgId: 'org_a',
			siteId: 'site_1',
			release: 'rel-old'
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('That release is not registered'));
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Try Again')
			?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('The earlier code can run'));
		await wrapper.find('button').trigger('click');
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Confirm Roll Back')
			?.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Another change to this site is still running.')
		);
		expect(navigate).not.toHaveBeenCalled();
	});
});
