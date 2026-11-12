import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeReport } from '~/shared/cloudflare-probe';
import { usePlanesStore } from '~/stores/planes';
import { calls, clearBrowserState, registerApi } from './store-support';

const ORG_ID = 'org_a';
const PATH = `POST /api/v1/orgs/${ORG_ID}/planes/cloudflare/probe`;
const TOKEN = 'user-token-value-0123456789';

const report: ProbeReport = {
	status: 'active',
	kind: 'user',
	tokenId: 'tok_1',
	expiresOn: null,
	accounts: [{ id: 'acc_1', name: 'Campus Site' }],
	account: { id: 'acc_1', name: 'Campus Site' },
	capabilities: [
		{
			id: 'scripts',
			label: 'Site scripts',
			state: 'granted',
			permission: 'Workers Scripts Edit',
			retryHint: null
		}
	],
	canDownscope: false
};

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	usePlanesStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('planes store', () => {
	it('keeps the report and sends the token with the chosen account', async () => {
		cleanup = registerApi({ [PATH]: () => ({ body: report }) });
		const store = usePlanesStore();
		await store.probe(ORG_ID, TOKEN, 'acc_1');
		expect(store.report).toEqual(report);
		expect(store.probing).toBe(false);
		expect(calls.at(-1)?.body).toEqual({ token: TOKEN, accountId: 'acc_1' });
	});

	it('sends no account when the caller names none', async () => {
		cleanup = registerApi({ [PATH]: () => ({ body: report }) });
		await usePlanesStore().probe(ORG_ID, TOKEN);
		expect(calls.at(-1)?.body).toEqual({ token: TOKEN });
	});

	it('never keeps the token in state', async () => {
		cleanup = registerApi({ [PATH]: () => ({ body: report }) });
		const store = usePlanesStore();
		await store.probe(ORG_ID, TOKEN);
		expect(JSON.stringify(store.$state)).not.toContain(TOKEN);
	});

	it('holds the refusal as the error and drops any earlier report', async () => {
		cleanup = registerApi({
			[PATH]: () => ({
				status: 422,
				body: {
					code: 'unprocessable',
					message: 'That account is not visible to this token.',
					details: {},
					requestId: 'req_1'
				}
			})
		});
		const store = usePlanesStore();
		store.report = report;
		await store.probe(ORG_ID, TOKEN, 'acc_9');
		expect(store.report).toBeUndefined();
		expect(store.error?.message).toBe('That account is not visible to this token.');
	});

	it('clears the report and the error', async () => {
		cleanup = registerApi({ [PATH]: () => ({ body: report }) });
		const store = usePlanesStore();
		await store.probe(ORG_ID, TOKEN);
		store.clear();
		expect(store.report).toBeUndefined();
		expect(store.error).toBeNull();
	});
});
