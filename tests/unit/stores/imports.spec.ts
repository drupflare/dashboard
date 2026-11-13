import { afterEach, describe, expect, it } from 'vitest';
import { useImportsStore } from '~/stores/imports';
import { useOperationsStore } from '~/stores/operations';
import { calls, clearBrowserState, registerApi } from './store-support';

let cleanup: () => void = () => undefined;

const dossier = {
	verdict: 'ready',
	importable: true,
	refusals: [],
	estimate: { bytes: 2048, fileCount: 0 },
	findings: []
};
const survey = {
	v: 1,
	host: 'files.example.test',
	root: '/var/www/html',
	capturedAt: '2026-11-13T00:00:00.000Z',
	dossier
};

afterEach(() => {
	cleanup();
	clearBrowserState();
	useImportsStore().reset();
	useOperationsStore().reset();
});

describe('imports store survey cache', () => {
	it('leaves a running survey not loaded, then loads its dossier once it succeeds', async () => {
		let status = 'running';
		cleanup = registerApi({
			'GET /api/v1/orgs/org_1/operations/op_survey': () => ({
				body: {
					id: 'op_survey',
					type: 'import.survey',
					status,
					steps: [],
					targetIds: [],
					cursor: status === 'succeeded' ? JSON.stringify(survey) : null
				}
			})
		});

		const store = useImportsStore();
		await store.readSurvey('org_1', 'op_survey');
		expect(store.surveys.get('op_survey')).toBeUndefined();

		status = 'succeeded';
		await store.readSurvey('org_1', 'op_survey');
		expect(store.surveys.get('op_survey')).toEqual(survey);
	});

	it('records a survey that no longer exists as known absent', async () => {
		cleanup = registerApi({
			'GET /api/v1/orgs/org_1/operations/op_gone': {
				status: 404,
				body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_1' }
			}
		});

		const store = useImportsStore();
		await expect(store.readSurvey('org_1', 'op_gone')).resolves.toBeNull();
		expect(store.surveys.get('op_gone')).toBeNull();
	});

	it('clears the cache on reset', async () => {
		cleanup = registerApi({
			'GET /api/v1/orgs/org_1/operations/op_survey': {
				body: {
					id: 'op_survey',
					type: 'import.survey',
					status: 'succeeded',
					steps: [],
					targetIds: [],
					cursor: JSON.stringify(survey)
				}
			}
		});

		const store = useImportsStore();
		await store.readSurvey('org_1', 'op_survey');
		store.reset();
		expect(store.surveys.has('op_survey')).toBe(false);
		expect(store.credential).toBeNull();
	});
});

describe('imports store requests', () => {
	it('keeps the returned public key in the store for the form to show', async () => {
		const credential = {
			id: 'imc_1',
			publicKey: 'ssh-ed25519 AAAATEST drupflare-import',
			host: 'files.example.test',
			port: 22,
			username: 'drupal',
			expiresAt: '2026-11-14T00:00:00.000Z'
		};
		cleanup = registerApi({
			'POST /api/v1/orgs/org_1/imports/credentials': { status: 201, body: credential }
		});

		const store = useImportsStore();
		await expect(
			store.createCredential('org_1', {
				host: 'files.example.test',
				port: 22,
				username: 'drupal'
			})
		).resolves.toEqual(credential);
		expect(store.credential).toEqual(credential);
	});

	it('sends the Idempotency-Key header when it starts a survey', async () => {
		cleanup = registerApi({
			'POST /api/v1/orgs/org_1/imports/survey': {
				status: 202,
				body: {
					id: 'op_survey',
					type: 'import.survey',
					status: 'planned',
					steps: [],
					targetIds: [],
					cursor: null
				}
			}
		});

		await useImportsStore().startSurvey('org_1', 'imc_1', '/var/www/html', 'key-survey-1');
		const call = calls.find((entry) => entry.path === '/api/v1/orgs/org_1/imports/survey');
		expect(call?.headers['idempotency-key']).toBe('key-survey-1');
		expect(call?.body).toEqual({ credentialId: 'imc_1', root: '/var/www/html' });
	});
});
