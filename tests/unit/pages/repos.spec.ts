import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReposPage from '~/pages/repos/index.vue';
import { useCorpusStore } from '~/stores/corpus';
import { useOrgStore } from '~/stores/org';
import { useRepoConnectionsStore } from '~/stores/repo-connections';
import { useSessionStore } from '~/stores/session';
import { clearBrowserState, failure, registerApi, type Reply } from '../stores/store-support';

const ORG = 'org_personal';
const owner = { id: ORG, name: 'Personal', personal: true, role: 'owner' };
const corpusPath = `/api/v1/orgs/${ORG}/corpus`;
const listPath = `/api/v1/orgs/${ORG}/repo-connections`;

const list = {
	rows: ['install', 'file rw'],
	items: [
		{
			id: 'good',
			name: 'good',
			status: 'verified',
			install: { allowed: true },
			cells: { install: { state: 'inline' }, 'file rw': { state: 'inline' } }
		},
		{
			id: 'half',
			name: 'half',
			status: 'partial',
			install: { allowed: false, reason: 'half is partial in the corpus' },
			cells: { install: { state: 'inline' }, 'file rw': { state: 'unsupported' } }
		}
	]
};

const github = {
	id: 'rc_1',
	provider: 'github',
	displayName: 'acme',
	scopes: [],
	state: 'active',
	createdAt: 1_700_000_000_000
};

type Route = Reply | ((call: { query: Record<string, string> }) => Reply | Promise<Reply>);

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

function signIn() {
	useSessionStore().me = {
		id: 'usr_1',
		email: 'owner@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil: null
	};
}

function setup(corpus: Route, connections: Route = { body: { items: [] } }) {
	cleanup = registerApi({
		'GET /api/v1/me': () => ({ body: { ...useSessionStore().me, via: 'session' } }),
		'GET /api/v1/me/organizations': { body: { items: [owner], nextCursor: null } },
		[`GET ${corpusPath}`]: corpus,
		[`GET ${listPath}`]: connections,
		[`GET ${listPath}/rc_1/repositories`]: {
			body: {
				items: [
					{ fullName: 'acme/site', defaultBranch: 'trunk' },
					{ fullName: 'acme/other', defaultBranch: null }
				]
			}
		}
	} as Parameters<typeof registerApi>[0]);
}

// a new query each mount, so the router runs the org middleware again for every test
let mounts = 0;
async function mountPage() {
	mounts += 1;
	const wrapper = await mountSuspended(ReposPage, {
		route: `/repos?mount=${mounts}`,
		attachTo: document.body
	});
	mounted.push(wrapper);
	return wrapper;
}

const buttonNamed = (wrapper: Awaited<ReturnType<typeof mountPage>>, text: string) =>
	wrapper.findAll('button').filter((item) => item.text().trim() === text);

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useCorpusStore().$reset();
	useRepoConnectionsStore().$reset();
	signIn();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('repositories page', () => {
	it('shows a verified codebase as allowed and a refused one with its reason', async () => {
		setup({ body: list });

		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('half is partial in the corpus'));
		expect(wrapper.text()).toContain('Allowed');
		expect(wrapper.text()).toContain('Refused');
	});

	it('opens the install options for the picked codebase with its refusal reason and the four modes', async () => {
		setup({ body: list });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(buttonNamed(wrapper, 'Install Options')).toHaveLength(2));

		await buttonNamed(wrapper, 'Install Options')[1]!.trigger('click');

		await vi.waitFor(() => {
			const text = document.body.textContent ?? '';
			expect(text).toContain('Change a Module');
			expect(text).toContain('half is partial in the corpus');
		});
	});

	it('shows the empty state when no codebase matches the search', async () => {
		setup((call) => (call.query.q ? { body: { rows: list.rows, items: [] } } : { body: list }));
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('good'));

		await wrapper.find('input[placeholder="Search by codebase name"]').setValue('zzz');

		await vi.waitFor(() => expect(wrapper.text()).toContain('No Codebases Match'));
	});

	it('shows the error state with the request id when the list does not load', async () => {
		setup(failure('internal', 'The list did not load', 'req_9'));

		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Codebases'));
		expect(wrapper.text()).toContain('The list did not load');
	});

	it('lists the repositories of a connected provider and filters them by name', async () => {
		setup({ body: list }, { body: { items: [github] } });
		const wrapper = await mountPage();

		// the tab list switches on mousedown, not click
		await buttonNamed(wrapper, 'Connected Repositories')[0]!.trigger('mousedown');

		await vi.waitFor(() => expect(wrapper.text()).toContain('acme/site'));
		expect(wrapper.text()).toContain('Not Reported');

		await wrapper.find('input[placeholder="Filter by repository name"]').setValue('other');

		await vi.waitFor(() => expect(wrapper.text()).not.toContain('acme/site'));
		expect(wrapper.text()).toContain('acme/other');
	});
});
