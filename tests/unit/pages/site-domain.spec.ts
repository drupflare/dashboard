import { mountSuspended } from '@nuxt/test-utils/runtime';
import type { DOMWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SiteDomainForm from '~/components/site/domain/Form.vue';
import SiteDomainRecords from '~/components/site/domain/Records.vue';
import SiteDomainStages from '~/components/site/domain/Stages.vue';
import DomainPage from '~/pages/sites/[id]/domain.vue';
import { STAGE_COPY, type AttachStage, type DnsRecord } from '~/shared/domain-copy';
import { useDomainStore, type AttachView, type DomainPayload } from '~/stores/domain';
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
	{ purpose: 'ownership', type: 'TXT', name: `_cf-custom-hostname.${HOST}`, value: 'own-1' },
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
		checks: 3,
		reason: null,
		updatedAt: 5,
		...over
	} satisfies AttachView;
}

function payload(over: Partial<DomainPayload> = {}): DomainPayload {
	return { ready: true, attached: [], attach: null, ...over };
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
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useDomainStore().$reset();
	useSessionStore().me = me(soon());
	readReply = () => ({ body: payload() });
	siteReply = () => ({ body: site });
	cleanup = registerApi({
		'GET /api/v1/me': { body: me(soon()) },
		[`GET /api/v1/sites/${SITE}`]: () => siteReply(),
		[`GET ${base}`]: () => readReply(),
		[`POST ${base}`]: { status: 202, body: {} }
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
		const wrapper = await mountSuspended(SiteDomainRecords, {
			props: { hostname: HOST, records: RECORDS }
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('What You Do at Your DNS Provider');
		expect(wrapper.get('[data-test="record-ownership"]').text()).toContain(
			'Proves you own the domain'
		);
		expect(wrapper.get('[data-test="record-ownership"]').text()).toContain(
			`_cf-custom-hostname.${HOST}`
		);
		expect(wrapper.get('[data-test="record-certificate"]').text()).toContain('cert-1');
		expect(wrapper.get('[data-test="record-traffic"]').text()).toContain('CNAME');
		expect(wrapper.get('[data-test="record-traffic"]').text()).toContain('edge.example.net');
	});

	it('adds the ALIAS hint for the bare domain only', async () => {
		const bare = await mountSuspended(SiteDomainRecords, {
			props: { hostname: 'example.edu', records: RECORDS }
		});
		mounted.push(bare);
		expect(bare.text()).toContain('ALIAS or ANAME');
		const sub = await mountSuspended(SiteDomainRecords, {
			props: { hostname: HOST, records: RECORDS }
		});
		mounted.push(sub);
		expect(sub.text()).not.toContain('ALIAS or ANAME');
	});
});

describe('form component', () => {
	it('keeps Attach Domain disabled until the name is a domain the owner can attach', async () => {
		const wrapper = await mountSuspended(SiteDomainForm, {
			props: { busy: false, error: null }
		});
		mounted.push(wrapper);
		const attach = () => button(wrapper, 'Attach Domain')!;
		expect(attach().attributes('disabled')).toBeDefined();
		await wrapper.get('input[name="hostname"]').setValue('www.drupflare.app');
		expect(attach().attributes('disabled')).toBeDefined();
		await wrapper.get('input[name="hostname"]').trigger('blur');
		expect(wrapper.text()).toContain('Drupflare keeps this domain for its own sites');
		await wrapper.get('input[name="hostname"]').setValue('  WWW.Example.Edu ');
		expect(attach().attributes('disabled')).toBeUndefined();
		await wrapper.get('form').trigger('submit');
		expect(wrapper.emitted('attach')).toEqual([[HOST]]);
	});

	it('shows the refusal it is given', async () => {
		const wrapper = await mountSuspended(SiteDomainForm, {
			props: { busy: false, error: 'Another change is running.' }
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
		await wrapper.get('form').trigger('submit');
		await vi.waitFor(() =>
			expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
		);
		const post = calls.find((call) => call.method === 'POST')!;
		expect(post.path).toBe(base);
		expect(post.body).toEqual({ hostname: HOST });
		expect(post.headers['idempotency-key']).toMatch(/\S/);
	});

	it('asks for a fresh sign-in before it sends on a stale session', async () => {
		useSessionStore().me = me(null);
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[name="hostname"]').exists()).toBe(true));
		await wrapper.get('input[name="hostname"]').setValue(HOST);
		await wrapper.get('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Confirm Your Identity'));
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
	});

	it('shows the refusal of the server in plain words', async () => {
		cleanup();
		cleanup = registerApi({
			'GET /api/v1/me': { body: me(soon()) },
			[`GET /api/v1/sites/${SITE}`]: () => siteReply(),
			[`GET ${base}`]: () => readReply(),
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
		await wrapper.get('form').trigger('submit');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Wait for it to finish, then try again.')
		);
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
