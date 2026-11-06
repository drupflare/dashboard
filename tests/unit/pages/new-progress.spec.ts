import { useNuxtApp } from '#app';
import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProgressPage from '~/pages/new/progress/[op].vue';
import { useOperationsStore } from '~/stores/operations';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { clearBrowserState, failure, registerApi, type Reply } from '../stores/store-support';

const personal = { id: 'org_personal', name: 'Personal', personal: true, role: 'owner' };
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};
const opKey = `GET /api/v1/orgs/${personal.id}/operations/op_1`;
const siteKey = 'GET /api/v1/sites/site_1';
const secretKey = `POST /api/v1/orgs/${personal.id}/sites/site_1/first-run-secret`;
const password = 'Pw-Test-7d3f-admin';

const site = {
	id: 'site_1',
	orgId: personal.id,
	name: 'quiet-oak-harbor',
	kind: 'drupal',
	category: 'cms',
	plane: 'managed',
	config: 'managed',
	accountId: null,
	state: 'active',
	ring: 'R1',
	primaryHostname: 'quiet-oak-harbor.drupflare.app',
	hostnames: [],
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z'
};

function step(id: string, name: string, state: string, error: string | null = null) {
	return {
		id,
		name,
		state,
		attempt: 1,
		startedAt: null,
		finishedAt: null,
		error
	};
}

function operation(status: string, steps: ReturnType<typeof step>[]) {
	return {
		id: 'op_1',
		orgId: personal.id,
		type: 'site.create',
		status,
		targetIds: ['site_1'],
		steps,
		finalObservation: null,
		updatedAt: '2026-01-01T00:00:00Z'
	};
}

let cleanup: () => void = () => undefined;
let opReply: () => Reply;
let secretReply: () => Reply;
const mounted: { unmount: () => void }[] = [];

beforeEach(async () => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useOperationsStore().reset();
	opReply = () => ({
		body: operation('running', [step('a', 'Reserve quiet-oak-harbor', 'succeeded')])
	});
	secretReply = () => ({ body: { kind: 'admin-password', value: password } });
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
		[opKey]: () => opReply(),
		[siteKey]: { body: site },
		[secretKey]: () => secretReply()
	});
	await useOrgStore().ensure();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(ProgressPage, { route: '/new/progress/op_1' });
	mounted.push(wrapper);
	return wrapper;
}

function revealButton(wrapper: {
	findAll(selector: string): { text(): string; trigger(e: string): Promise<unknown> }[];
}) {
	return wrapper.findAll('button').find((b) => b.text().trim() === 'Reveal Password');
}

describe('create progress', () => {
	it('renders every step state with an icon and text, and names the running step', async () => {
		opReply = () => ({
			body: operation('running', [
				step('a', 'Take the site writer lease', 'succeeded'),
				step('b', 'Upload static assets', 'running'),
				step('c', 'Upload the script', 'pending'),
				step('d', 'Probe the site', 'skipped'),
				step('e', 'Route the hostname', 'failed')
			])
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.findAll('li')).toHaveLength(5));
		const text = wrapper.text();
		for (const label of ['Succeeded', 'Running', 'Pending', 'Skipped', 'Failed']) {
			expect(text).toContain(label);
		}
		expect(wrapper.html()).toContain('loader-circle');
		expect(text).toContain('Now: Upload static assets');
	});

	it('reveals the admin password once, then shows Already Shown on a second reveal', async () => {
		opReply = () => ({
			body: operation('succeeded', [step('a', 'Mark the site active', 'succeeded')])
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('quiet-oak-harbor.drupflare.app'));
		expect(wrapper.text()).not.toContain(password);
		expect(wrapper.text()).toContain('Open Admin');

		await revealButton(wrapper)?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain(password));
		expect(wrapper.text()).toContain('will not be shown again');

		wrapper.unmount();
		secretReply = () => ({
			status: 404,
			body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_2' }
		});
		const again = await mountPage();
		await vi.waitFor(() => expect(revealButton(again)).toBeDefined());
		await revealButton(again)?.trigger('click');

		await vi.waitFor(() => expect(again.text()).toContain('Already Shown'));
		expect(again.text()).not.toContain(password);
		expect(again.find('[role="alert"]').exists()).toBe(false);
	});

	it('keeps the password out of every store and out of the DOM after leaving', async () => {
		opReply = () => ({
			body: operation('succeeded', [step('a', 'Mark the site active', 'succeeded')])
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(revealButton(wrapper)).toBeDefined());

		const pinia = useNuxtApp().$pinia;
		expect(JSON.stringify(pinia.state.value)).not.toContain(password);

		await revealButton(wrapper)?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain(password));
		expect(JSON.stringify(pinia.state.value)).not.toContain(password);
		expect(sessionStorage.getItem('drupflare.onboarding') ?? '').not.toContain(password);

		wrapper.unmount();
		expect(document.body.innerHTML).not.toContain(password);
	});

	it('shows the failed step, the server reason, the rollback and a Try Again that starts over', async () => {
		opReply = () => ({
			body: {
				...operation('rolled-back', [
					step('a', 'Reserve quiet-oak-harbor', 'succeeded'),
					step('b', 'Upload static assets', 'failed', 'Upload rejected by the worker')
				]),
				finalObservation: null
			}
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Create the Site'));
		expect(wrapper.text()).toContain('Upload rejected by the worker');
		expect(wrapper.text()).toContain('Failed step: Upload static assets');
		expect(wrapper.text()).toContain('rolled back');

		const retry = wrapper.findAll('button').find((b) => b.text().trim() === 'Try Again');
		await retry?.trigger('click');
		await vi.waitFor(() => expect(useRouter().currentRoute.value.path).toBe('/new'));
	});

	it('shows the operation as not found without an error banner', async () => {
		opReply = () => ({
			status: 404,
			body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_3' }
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Operation Not Found'));
	});

	it('reports a failed operation read with its request id', async () => {
		opReply = () => failure('internal', 'Failed', 'req_read');
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load the Operation'));
		expect(wrapper.text()).toContain('req_read');
	});
});
