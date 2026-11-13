import { mountSuspended } from '@nuxt/test-utils/runtime';
import type { DOMWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SiteDomainForm from '~/components/site/domain/Form.vue';
import SiteDomainRecords from '~/components/site/domain/Records.vue';
import SiteDomainStages from '~/components/site/domain/Stages.vue';
import DomainPage from '~/pages/sites/[id]/domain.vue';
import {
	STAGE_COPY,
	attachFailureReason,
	type AttachStage,
	type DnsRecord
} from '~/shared/domain-copy';
import {
	useDomainStore,
	type AttachView,
	type DomainCheck,
	type DomainPayload
} from '~/stores/domain';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi, type Reply } from '../stores/store-support';

const ORG = 'org_personal';
const SITE = 'site_1';
const HOST = 'www.example.edu';
const base = `/api/v1/orgs/${ORG}/sites/${SITE}/domain`;
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

const RECORDS: DnsRecord[] = [
	{
		purpose: 'ownership',
		type: 'TXT',
		name: `_drupflare-challenge.${HOST}`,
		value: 'drupflare-verify=ABC'
	},
	{ purpose: 'certificate', type: 'TXT', name: `_acme-challenge.${HOST}`, value: 'cert-1' },
	{ purpose: 'traffic', type: 'CNAME', name: HOST, value: 'edge.example.net' }
];

const STAGES: AttachStage[] = ['ownership', 'certificate', 'routing', 'verification'];

function view(states: AttachView['stages'][number]['state'][], over: Partial<AttachView> = {}) {
	return {
		operationId: 'op_1',
		hostname: HOST,
		status: 'running',
		stages: STAGES.map((id, index) => ({
			id,
			label: STAGE_COPY[id].label,
			state: states[index] ?? 'waiting',
			text: STAGE_COPY[id].pending
		})),
		records: RECORDS,
		notice: null,
		checks: 3,
		reason: null,
		expiresAt: null,
		updatedAt: 5,
		...over
	} satisfies AttachView;
}

function checked(over: Partial<DomainCheck> = {}): DomainCheck {
	return {
		hostname: HOST,
		apex: false,
		held: false,
		routingKnown: true,
		unknown: false,
		records: [
			{
				...RECORDS[0]!,
				status: 'missing',
				statusText: 'Not found yet',
				found: []
			},
			{
				...RECORDS[2]!,
				status: 'wrong',
				statusText: 'Found with a different value',
				found: ['other.example.net']
			}
		],
		hazards: [],
		...over
	};
}

function payload(over: Partial<DomainPayload> = {}): DomainPayload {
	return { ready: true, enabled: true, attached: [], attach: null, ...over };
}

const me = (stepUpUntil: string | null) => ({
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session' as const,
	stepUpUntil
});

let cleanup: () => void = () => undefined;
let readReply: () => Reply;
let siteReply: () => Reply;
let checkReply: () => Reply;
let releaseReply: () => Reply;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useDomainStore().$reset();
	useSessionStore().me = me(soon());
	readReply = () => ({ body: payload() });
	siteReply = () => ({ body: site });
	checkReply = () => ({ body: checked() });
	releaseReply = () => ({ body: { hostname: HOST, released: true } });
	cleanup = registerApi({
		'GET /api/v1/me': { body: me(soon()) },
		[`GET /api/v1/sites/${SITE}`]: () => siteReply(),
		[`GET ${base}`]: () => readReply(),
		[`POST ${base}`]: { status: 202, body: {} },
		[`POST ${base}/check`]: () => checkReply(),
		[`POST ${base}/release`]: () => releaseReply()
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(DomainPage, { route: `/sites/${SITE}/domain` });
	mounted.push(wrapper);
	return wrapper;
}

const button = (wrapper: { findAll: (selector: string) => DOMWrapper<Element>[] }, text: string) =>
	wrapper.findAll('button').find((candidate) => candidate.text() === text);

describe('stages component', () => {
	it('shows the four stages in order with a plain state for each', async () => {
		const wrapper = await mountSuspended(SiteDomainStages, {
			props: { view: view(['done', 'pending', 'waiting', 'waiting']) }
		});
		mounted.push(wrapper);
		const items = wrapper.findAll('li');
		expect(items.map((item) => item.attributes('data-test'))).toEqual([
			'stage-ownership',
			'stage-certificate',
			'stage-routing',
			'stage-verification'
		]);
		expect(items.map((item) => item.attributes('data-state'))).toEqual([
			'done',
			'pending',
			'waiting',
			'waiting'
		]);
		expect(items[0]!.text()).toContain('Ownership Check (Done)');
		expect(items[1]!.text()).toContain('Secure Certificate (In progress)');
		expect(items[2]!.text()).toContain('Routing (Not started)');
	});

	it('marks the stage that stopped', async () => {
		const wrapper = await mountSuspended(SiteDomainStages, {
			props: { view: view(['done', 'failed', 'waiting', 'waiting']) }
		});
		mounted.push(wrapper);
		expect(wrapper.get('[data-test="stage-certificate"]').text()).toContain('(Stopped)');
	});
});

describe('records component', () => {
	it('lists what to add at the DNS provider, each with its purpose', async () => {
		const wrapper = await mountSuspended(SiteDomainRecords, { props: { records: RECORDS } });
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('What You Do at Your DNS Provider');
		expect(wrapper.get('[data-test="record-ownership"]').text()).toContain(
			'Proves you own the domain'
		);
		expect(wrapper.get('[data-test="record-ownership"]').text()).toContain(
			`_drupflare-challenge.${HOST}`
		);
		expect(wrapper.get('[data-test="record-certificate"]').text()).toContain('cert-1');
		expect(wrapper.get('[data-test="record-traffic"]').text()).toContain('CNAME');
		expect(wrapper.get('[data-test="record-traffic"]').text()).toContain('edge.example.net');
		expect(wrapper.find('[data-test="status"]').exists()).toBe(false);
	});

	it('shows the status of each record and what Drupflare found instead', async () => {
		const result = checked();
		const wrapper = await mountSuspended(SiteDomainRecords, {
			props: { records: result.records }
		});
		mounted.push(wrapper);
		const owned = wrapper.get('[data-test="record-ownership"]');
		expect(owned.attributes('data-status')).toBe('missing');
		expect(owned.get('[data-test="status"]').text()).toContain('Not found yet');
		expect(owned.find('[data-test="found"]').exists()).toBe(false);
		const routed = wrapper.get('[data-test="record-traffic"]');
		expect(routed.get('[data-test="status"]').text()).toContain('different value');
		expect(routed.get('[data-test="found"]').text()).toContain('other.example.net');
	});

	it('shows the note on a record and the hazards under the list', async () => {
		const wrapper = await mountSuspended(SiteDomainRecords, {
			props: {
				records: [{ ...RECORDS[2]!, note: 'Ask your provider for an ALIAS record.' }],
				hazards: [{ code: 'caa_blocks', text: 'A CAA record blocks the certificate.' }]
			}
		});
		mounted.push(wrapper);
		expect(wrapper.get('[data-test="note"]').text()).toContain('ALIAS');
		expect(wrapper.get('[data-test="hazard-caa_blocks"]').text()).toContain('CAA record');
	});

	it('says the address record comes later while custom domains are off', async () => {
		const wrapper = await mountSuspended(SiteDomainRecords, {
			props: {
				records: [RECORDS[0]!],
				routingLater: true,
				routingLaterText: 'The address record appears here later.'
			}
		});
		mounted.push(wrapper);
		expect(wrapper.get('[data-test="routing-later"]').text()).toContain('appears here later');
	});
});

describe('form component', () => {
	it('keeps both buttons disabled until the name is a domain the owner can attach', async () => {
		const wrapper = await mountSuspended(SiteDomainForm, {
			props: { busy: false, checking: false, error: null }
		});
		mounted.push(wrapper);
		const attach = () => button(wrapper, 'Attach Domain')!;
		const show = () => button(wrapper, 'Show Records')!;
		expect(attach().attributes('disabled')).toBeDefined();
		expect(show().attributes('disabled')).toBeDefined();
		await wrapper.get('input[name="hostname"]').setValue('www.drupflare.app');
		expect(attach().attributes('disabled')).toBeDefined();
		await wrapper.get('input[name="hostname"]').trigger('blur');
		expect(wrapper.text()).toContain('Drupflare keeps this domain for its own sites');
		await wrapper.get('input[name="hostname"]').setValue('  WWW.Example.Edu ');
		expect(attach().attributes('disabled')).toBeUndefined();
		expect(show().attributes('disabled')).toBeUndefined();
	});

	it('shows the records on submit and attaches only on the Attach Domain button', async () => {
		const wrapper = await mountSuspended(SiteDomainForm, {
			props: { busy: false, checking: false, error: null }
		});
		mounted.push(wrapper);
		await wrapper.get('input[name="hostname"]').setValue('  WWW.Example.Edu ');
		await wrapper.get('form').trigger('submit');
		expect(wrapper.emitted('check')).toEqual([[HOST]]);
		expect(wrapper.emitted('attach')).toBeUndefined();
		await button(wrapper, 'Attach Domain')!.trigger('click');
		expect(wrapper.emitted('attach')).toEqual([[HOST]]);
	});

	it('shows the refusal it is given', async () => {
		const wrapper = await mountSuspended(SiteDomainForm, {
			props: { busy: false, checking: false, error: 'Another change is running.' }
		});
		mounted.push(wrapper);
		expect(wrapper.get('[role="alert"]').text()).toBe('Another change is running.');
	});
});

describe('domain page', () => {
	it('shows the form for a site with no attach', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Attach Domain'));
		expect(wrapper.text()).toContain('Domain for campus-site');
		expect(wrapper.find('[data-test="records"]').exists()).toBe(false);
	});

	it('says a site that is not managed cannot take a domain', async () => {
		readReply = () => ({ body: payload({ ready: false }) });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('This Site Cannot Take a Domain'));
		expect(wrapper.text()).not.toContain('Attach Domain');
	});

	it('shows the stages and the records while an attach runs, and hides the form', async () => {
		readReply = () => ({ body: payload({ attach: view(['pending']) }) });
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.find('[data-test="stage-ownership"]').exists()).toBe(true)
		);
		expect(wrapper.findAll('[data-test^="stage-"]')).toHaveLength(4);
		expect(wrapper.find('[data-test="records"]').exists()).toBe(true);
		expect(button(wrapper, 'Attach Domain')).toBeUndefined();
	});

	it('shows the plain reason and the form again when the attach stopped', async () => {
		readReply = () => ({
			body: payload({
				attach: view(['done', 'failed'], {
					status: 'failed',
					reason: 'The certificate could not be issued.'
				})
			})
		});
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('The certificate could not be issued.')
		);
		expect(button(wrapper, 'Attach Domain')).toBeDefined();
		expect(wrapper.find('[data-test="records"]').exists()).toBe(true);
	});

	it('tells the displaced owner that another site proved the name, without naming it', async () => {
		const reason = attachFailureReason('hostname_displaced')!;
		readReply = () => ({
			body: payload({ attach: view(['pending'], { status: 'failed', reason }) })
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('proved ownership of this name'));
		expect(wrapper.text()).not.toMatch(/org_|site_/);
		expect(button(wrapper, 'Attach Domain')).toBeDefined();
	});

	it('says the domain is attached once every stage is done and drops the records', async () => {
		readReply = () => ({
			body: payload({
				attached: [{ hostname: HOST, since: 5 }],
				attach: view(['done', 'done', 'done', 'done'], { status: 'succeeded' })
			})
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('[data-test="done"]').exists()).toBe(true));
		expect(wrapper.find('[data-test="records"]').exists()).toBe(false);
		expect(wrapper.get('[data-test="attached"]').text()).toContain(HOST);
	});

	it('sends the domain once, with an idempotency key, when Attach Domain is pressed', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[name="hostname"]').exists()).toBe(true));
		await wrapper.get('input[name="hostname"]').setValue(HOST);
		await button(wrapper, 'Attach Domain')!.trigger('click');
		await vi.waitFor(() =>
			expect(
				calls.filter((call) => call.method === 'POST' && call.path === base)
			).toHaveLength(1)
		);
		const post = calls.find((call) => call.method === 'POST' && call.path === base)!;
		expect(post.path).toBe(base);
		expect(post.body).toEqual({ hostname: HOST });
		expect(post.headers['idempotency-key']).toMatch(/\S/);
	});

	it('asks for a fresh sign-in before it sends on a stale session', async () => {
		useSessionStore().me = me(null);
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[name="hostname"]').exists()).toBe(true));
		await wrapper.get('input[name="hostname"]').setValue(HOST);
		await button(wrapper, 'Attach Domain')!.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Confirm Your Identity'));
		expect(calls.filter((call) => call.method === 'POST' && call.path === base)).toHaveLength(
			0
		);
	});

	it('shows the refusal of the server in plain words', async () => {
		cleanup();
		cleanup = registerApi({
			'GET /api/v1/me': { body: me(soon()) },
			[`GET /api/v1/sites/${SITE}`]: () => siteReply(),
			[`GET ${base}`]: () => readReply(),
			[`POST ${base}/check`]: () => checkReply(),
			[`POST ${base}`]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'Another change to this site is still running.',
					details: { reason: 'site_busy' }
				}
			}
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[name="hostname"]').exists()).toBe(true));
		await wrapper.get('input[name="hostname"]').setValue(HOST);
		await button(wrapper, 'Attach Domain')!.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Wait for it to finish, then try again.')
		);
	});

	it('shows the records with their status before anything starts, and starts nothing', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[name="hostname"]').exists()).toBe(true));
		await wrapper.get('input[name="hostname"]').setValue(HOST);
		await wrapper.get('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.find('[data-test="records"]').exists()).toBe(true));
		const check = calls.find((call) => call.path === `${base}/check`)!;
		expect(check.method).toBe('POST');
		expect(check.body).toEqual({ hostname: HOST });
		expect(wrapper.get('[data-test="record-ownership"]').attributes('data-status')).toBe(
			'missing'
		);
		expect(wrapper.get('[data-test="found"]').text()).toContain('other.example.net');
		expect(calls.filter((call) => call.path === base && call.method === 'POST')).toHaveLength(
			0
		);
	});

	it('shows the hazards the check found', async () => {
		checkReply = () => ({
			body: checked({
				hazards: [
					{ code: 'apex_cname', text: 'A CNAME record cannot sit on a bare domain.' }
				]
			})
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[name="hostname"]').exists()).toBe(true));
		await wrapper.get('input[name="hostname"]').setValue(HOST);
		await wrapper.get('form').trigger('submit');
		await vi.waitFor(() =>
			expect(wrapper.find('[data-test="hazard-apex_cname"]').exists()).toBe(true)
		);
	});

	it('says another site holds the domain and lists no records', async () => {
		checkReply = () => ({ body: checked({ held: true, records: [] }) });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[name="hostname"]').exists()).toBe(true));
		await wrapper.get('input[name="hostname"]').setValue(HOST);
		await wrapper.get('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Another site already holds'));
	});

	it('lists the records to add when an unproven claim holds the name, not the held message', async () => {
		checkReply = () => ({ body: checked({ held: false }) });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[name="hostname"]').exists()).toBe(true));
		await wrapper.get('input[name="hostname"]').setValue(HOST);
		await wrapper.get('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.find('[data-test="records"]').exists()).toBe(true));
		expect(wrapper.text()).not.toContain('Another site already holds');
		expect(wrapper.get('[data-test="record-ownership"]').text()).toContain(RECORDS[0]!.value);
	});

	it('says the address record comes later when custom domains are off', async () => {
		checkReply = () => ({
			body: checked({ routingKnown: false, records: checked().records.slice(0, 1) })
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[name="hostname"]').exists()).toBe(true));
		await wrapper.get('input[name="hostname"]').setValue(HOST);
		await wrapper.get('form').trigger('submit');
		await vi.waitFor(() =>
			expect(wrapper.find('[data-test="routing-later"]').exists()).toBe(true)
		);
	});

	it('shows the refusal of the check in plain words', async () => {
		checkReply = () => ({
			status: 422,
			body: {
				code: 'unprocessable',
				message: 'x',
				details: { reason: 'site_not_live' }
			}
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[name="hostname"]').exists()).toBe(true));
		await wrapper.get('input[name="hostname"]').setValue(HOST);
		await wrapper.get('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.text()).toContain('This site is not live'));
	});

	it('shows a calm waiting state with Try Again, which sends the attach again', async () => {
		readReply = () => ({
			body: payload({
				attach: view(['done', 'waiting', 'waiting', 'waiting'], {
					status: 'waiting',
					notice: 'Your domain is verified. Custom domains are not switched on yet.'
				})
			})
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('[data-test="waiting"]').exists()).toBe(true));
		expect(wrapper.get('[data-test="waiting"]').text()).toContain('Your domain is verified');
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
		await button(wrapper, 'Try Again')!.trigger('click');
		await vi.waitFor(() =>
			expect(
				calls.filter((call) => call.method === 'POST' && call.path === base)
			).toHaveLength(1)
		);
		const post = calls.find((call) => call.method === 'POST' && call.path === base)!;
		expect(post.body).toEqual({ hostname: HOST });
	});

	describe('a name that is waiting', () => {
		const EXPIRES = Date.UTC(2026, 10, 16, 15, 30);
		const waitingRecord = () =>
			payload({ attach: view(['pending'], { expiresAt: EXPIRES, status: 'running' }) });
		const releases = () =>
			calls.filter((call) => call.method === 'POST' && call.path === `${base}/release`);

		it('says it is waiting for the DNS record and shows when it stops waiting', async () => {
			readReply = () => ({ body: waitingRecord() });
			const wrapper = await mountPage();
			await vi.waitFor(() =>
				expect(wrapper.find('[data-test="waiting-record"]').exists()).toBe(true)
			);
			const block = wrapper.get('[data-test="waiting-record"]');
			expect(block.text()).toContain('Waiting for Your DNS Record');
			expect(wrapper.get('[data-test="expires"]').text()).toBe(
				`Drupflare stops waiting on ${new Intl.DateTimeFormat('en-US', {
					dateStyle: 'medium',
					timeStyle: 'short'
				}).format(new Date(EXPIRES))}.`
			);
		});

		it('offers no second attach for the name while it waits', async () => {
			readReply = () => ({ body: waitingRecord() });
			const wrapper = await mountPage();
			await vi.waitFor(() =>
				expect(wrapper.find('[data-test="waiting-record"]').exists()).toBe(true)
			);
			expect(button(wrapper, 'Attach Domain')).toBeUndefined();
			expect(wrapper.find('input[name="hostname"]').exists()).toBe(false);
		});

		it('does not show the waiting block once the record is found', async () => {
			readReply = () => ({ body: payload({ attach: view(['done', 'pending']) }) });
			const wrapper = await mountPage();
			await vi.waitFor(() =>
				expect(wrapper.find('[data-test="stage-ownership"]').exists()).toBe(true)
			);
			expect(wrapper.find('[data-test="waiting-record"]').exists()).toBe(false);
		});

		it('cancels the attach and shows the form again with the reason', async () => {
			readReply = () => ({ body: waitingRecord() });
			const wrapper = await mountPage();
			await vi.waitFor(() => expect(button(wrapper, 'Cancel This Attach')).toBeDefined());
			readReply = () => ({
				body: payload({
					attach: view(['failed'], {
						status: 'failed',
						reason: attachFailureReason('attach_cancelled')
					})
				})
			});
			await button(wrapper, 'Cancel This Attach')!.trigger('click');
			await vi.waitFor(() => expect(releases()).toHaveLength(1));
			expect(releases()[0]!.body).toEqual({ hostname: HOST });
			await vi.waitFor(() => expect(wrapper.text()).toContain('You cancelled this attach'));
			expect(wrapper.find('[data-test="waiting-record"]').exists()).toBe(false);
			expect(button(wrapper, 'Attach Domain')).toBeDefined();
		});

		it('asks for a fresh sign-in before it cancels on a stale session', async () => {
			useSessionStore().me = me(null);
			readReply = () => ({ body: waitingRecord() });
			const wrapper = await mountPage();
			await vi.waitFor(() => expect(button(wrapper, 'Cancel This Attach')).toBeDefined());
			await button(wrapper, 'Cancel This Attach')!.trigger('click');
			await vi.waitFor(() => expect(wrapper.text()).toContain('Confirm Your Identity'));
			expect(releases()).toHaveLength(0);
		});

		it('says why the server refused when the domain is already set up', async () => {
			releaseReply = () => ({
				status: 409,
				body: {
					code: 'conflict',
					message: 'This domain is already set up, so it cannot be cancelled here.',
					details: { reason: 'domain_in_use' }
				}
			});
			readReply = () => ({ body: waitingRecord() });
			const wrapper = await mountPage();
			await vi.waitFor(() => expect(button(wrapper, 'Cancel This Attach')).toBeDefined());
			await button(wrapper, 'Cancel This Attach')!.trigger('click');
			await vi.waitFor(() => expect(wrapper.text()).toContain('cannot be cancelled here'));
			expect(wrapper.find('[data-test="waiting-record"]').exists()).toBe(true);
		});

		it('lets the owner give up a verified name that is parked, beside Try Again', async () => {
			readReply = () => ({
				body: payload({
					attach: view(['done', 'waiting', 'waiting', 'waiting'], {
						status: 'waiting',
						notice: 'Your domain is verified. Custom domains are not switched on yet.'
					})
				})
			});
			const wrapper = await mountPage();
			await vi.waitFor(() =>
				expect(wrapper.find('[data-test="waiting"]').exists()).toBe(true)
			);
			expect(button(wrapper, 'Try Again')).toBeDefined();
			await button(wrapper, 'Cancel This Attach')!.trigger('click');
			await vi.waitFor(() => expect(releases()).toHaveLength(1));
		});
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
