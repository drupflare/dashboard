import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionBody, ObservationBody, PilotBody, PilotView } from '~/shared/pilots';
import { usePilotsStore } from '~/stores/pilots';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const ORG = 'org_campus';
const base = `/api/v1/orgs/${ORG}/pilots`;

const pilot = { id: 'pil_1', name: 'Shared drafts' } as PilotView;

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	usePilotsStore().$reset();
});

afterEach(() => {
	cleanup();
});

const count = (method: string, path: string) =>
	calls.filter((call) => call.method === method && call.path === path).length;

describe('pilots store', () => {
	it('loads the list once and reads it again only when forced', async () => {
		cleanup = registerApi({ [`GET ${base}`]: { body: { items: [pilot] } } });
		const store = usePilotsStore();
		await store.loadList(ORG);
		await store.loadList(ORG);
		expect(count('GET', base)).toBe(1);
		expect(store.lists.get(ORG)).toEqual([pilot]);
		await store.loadList(ORG, true);
		expect(count('GET', base)).toBe(2);
	});

	it('stores a missing pilot as null and keeps any other failure as the error', async () => {
		cleanup = registerApi({
			[`GET ${base}/pil_gone`]: {
				status: 404,
				body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_1' }
			},
			[`GET ${base}/pil_1`]: failure('internal', 'Something broke', 'req_2')
		});
		const store = usePilotsStore();
		await store.loadOne(ORG, 'pil_gone');
		expect(store.views.get('pil_gone')).toBeNull();
		expect(store.error).toBeNull();
		await store.loadOne(ORG, 'pil_1');
		expect(store.views.has('pil_1')).toBe(false);
		expect(store.error).not.toBeNull();
	});

	it('creates a pilot and reads the list again', async () => {
		cleanup = registerApi({
			[`POST ${base}`]: { status: 201, body: pilot },
			[`GET ${base}`]: { body: { items: [pilot] } }
		});
		const created = await usePilotsStore().create(ORG, { name: 'Shared drafts' } as PilotBody);
		expect(created).toEqual(pilot);
		expect(count('GET', base)).toBe(1);
	});

	it('returns null from a refused create and keeps the error for the form', async () => {
		cleanup = registerApi({
			[`POST ${base}`]: failure('validation', 'Start date is required', 'req_3')
		});
		const store = usePilotsStore();
		expect(await store.create(ORG, { name: '' } as PilotBody)).toBeNull();
		expect(store.saveError).not.toBeNull();
		expect(count('GET', base)).toBe(0);
	});

	it('replaces the stored pilot after an edit, a site change and a decision', async () => {
		cleanup = registerApi({
			[`PUT ${base}/pil_1`]: { body: { ...pilot, name: 'Renamed' } },
			[`PUT ${base}/pil_1/sites`]: { body: { ...pilot, name: 'Sites set' } },
			[`PUT ${base}/pil_1/decision`]: { body: { ...pilot, name: 'Decided' } },
			[`GET ${base}/pil_1/report`]: { body: { name: 'Decided' } }
		});
		const store = usePilotsStore();
		expect(await store.edit(ORG, 'pil_1', { name: 'Renamed' })).toBe(true);
		expect(store.views.get('pil_1')?.name).toBe('Renamed');
		expect(await store.setSites(ORG, 'pil_1', ['site_1'])).toBe(true);
		expect(calls.find((call) => call.path === `${base}/pil_1/sites`)?.body).toEqual({
			siteIds: ['site_1']
		});
		expect(await store.decide(ORG, 'pil_1', { decision: 'continue' } as DecisionBody)).toBe(
			true
		);
		expect(store.views.get('pil_1')?.name).toBe('Decided');
		expect(count('GET', `${base}/pil_1/report`)).toBe(1);
	});

	it('reads the report again after an observation is added', async () => {
		cleanup = registerApi({
			[`POST ${base}/pil_1/observations`]: { status: 201, body: { id: 'obs_1' } },
			[`GET ${base}/pil_1/report`]: { body: { name: 'Shared drafts', negativeResults: 0 } }
		});
		const store = usePilotsStore();
		expect(
			await store.addObservation(ORG, 'pil_1', { text: 'Cache hit rose' } as ObservationBody)
		).toBe(true);
		expect(store.reports.get('pil_1')).toMatchObject({ name: 'Shared drafts' });
	});

	it('keeps the error for a refused edit and leaves the stored pilot alone', async () => {
		cleanup = registerApi({
			[`PUT ${base}/pil_1`]: failure('conflict', 'Locked', 'req_4')
		});
		const store = usePilotsStore();
		store.views.set('pil_1', pilot);
		expect(await store.edit(ORG, 'pil_1', { name: 'Renamed' })).toBe(false);
		expect(store.views.get('pil_1')).toEqual(pilot);
		expect(store.saveError).not.toBeNull();
	});
});
