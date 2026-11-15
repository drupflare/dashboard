import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { corpusKey, useCorpusStore, type CorpusList } from '~/stores/corpus';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const ORG = 'org_a';
const path = `/api/v1/orgs/${ORG}/corpus`;

const list: CorpusList = {
	rows: ['install'],
	items: [
		{
			id: 'good',
			name: 'good',
			status: 'verified',
			install: { allowed: true },
			cells: { install: { state: 'inline' } }
		}
	]
};

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useCorpusStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('corpus store', () => {
	it('loads a search once and keeps the result', async () => {
		cleanup = registerApi({ [`GET ${path}`]: { body: list } });
		const corpus = useCorpusStore();

		await corpus.load(ORG, {});
		await corpus.load(ORG, {});

		expect(calls.filter((call) => call.path === path)).toHaveLength(1);
		expect(corpus.lists.get(corpusKey(ORG, {}))).toEqual(list);
	});

	it('sends the search text and status as the query', async () => {
		cleanup = registerApi({ [`GET ${path}`]: { body: { rows: [], items: [] } } });

		await useCorpusStore().load(ORG, { q: 'dr', status: 'verified' });

		expect(calls.at(-1)?.query).toEqual({ q: 'dr', status: 'verified' });
	});

	it('keeps a missing organization as known absent', async () => {
		cleanup = registerApi({
			[`GET ${path}`]: {
				status: 404,
				body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_1' }
			}
		});
		const corpus = useCorpusStore();

		await corpus.load(ORG, {});

		expect(corpus.lists.get(corpusKey(ORG, {}))).toBeNull();
		expect(corpus.error).toBeNull();
	});

	it('keeps a failure for the page and does not cache it', async () => {
		cleanup = registerApi({
			[`GET ${path}`]: failure('internal', 'The list did not load', 'req_2')
		});
		const corpus = useCorpusStore();

		await corpus.load(ORG, {});

		expect(corpus.error?.message).toBe('The list did not load');
		expect(corpus.lists.has(corpusKey(ORG, {}))).toBe(false);
	});
});
