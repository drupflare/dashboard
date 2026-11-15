import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RepairsPage from '~/pages/sites/[id]/repairs.vue';
import { useRepairsStore } from '~/stores/repairs';
import { useSessionStore } from '~/stores/session';
import { clearBrowserState, registerApi } from '../stores/store-support';

const ORG = 'org_personal';
const SITE = 'site_repairs001';
const listPath = `GET /api/v1/orgs/${ORG}/sites/${SITE}/repairs`;

const site = {
	id: SITE,
	orgId: ORG,
	name: 'Campus Site',
	kind: 'drupal',
	category: 'cms',
	plane: 'managed',
	config: 'managed',
	accountId: null,
	state: 'active',
	ring: 'R1',
	primaryHostname: 'www.example.edu',
	hostnames: [],
	admin: { username: null, email: null, password: 'unknown' },
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z'
};

const repair = {
	id: 'rpr_1',
	title: 'Blank Page Fixed',
	status: 'succeeded',
	statusText: 'Fixed',
	createdAt: '2026-11-01T12:00:00.000Z',
	before: 'Pages came back blank.',
	after: 'Checked again. The problem is gone.',
	canUndo: false,
	undoReason: 'This repair cannot be undone.',
	isUndo: false
};

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useRepairsStore().$reset();
	useSessionStore().me = {
		id: 'usr_1',
		email: 'owner@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil: null
	} as never;
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('site repairs page', () => {
	it('shows the repairs the site has had', async () => {
		cleanup = registerApi({
			'GET /api/v1/me': {
				body: {
					id: 'usr_1',
					email: 'owner@example.test',
					displayName: null,
					via: 'session',
					stepUpUntil: null
				}
			},
			[`GET /api/v1/sites/${SITE}`]: { body: site },
			[listPath]: { body: { items: [repair], nextCursor: null } }
		});
		const wrapper = await mountSuspended(RepairsPage, { route: `/sites/${SITE}/repairs` });
		mounted.push(wrapper);

		await vi.waitFor(() => expect(wrapper.text()).toContain('Blank Page Fixed'));
		expect(wrapper.text()).toContain('Checked again. The problem is gone.');
	});

	it('says there are no repairs yet when the site has none', async () => {
		cleanup = registerApi({
			'GET /api/v1/me': {
				body: {
					id: 'usr_1',
					email: 'owner@example.test',
					displayName: null,
					via: 'session',
					stepUpUntil: null
				}
			},
			[`GET /api/v1/sites/${SITE}`]: { body: site },
			[listPath]: { body: { items: [], nextCursor: null } }
		});
		const wrapper = await mountSuspended(RepairsPage, { route: `/sites/${SITE}/repairs` });
		mounted.push(wrapper);

		await vi.waitFor(() => expect(wrapper.text()).toContain('No automatic repairs yet'));
	});
});
