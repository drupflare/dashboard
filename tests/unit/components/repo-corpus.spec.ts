import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import Cells from '~/components/repo/corpus/Cells.vue';
import List from '~/components/repo/corpus/List.vue';
import Dialog from '~/components/repo/install/Dialog.vue';
import OwnDialog from '~/components/repo/own/Dialog.vue';
import Search from '~/components/repo/Search.vue';
import type { CorpusResult } from '~/shared/corpus';

const ROWS = ['install', 'file rw', 'outbound http'];

afterEach(() => {
	document.body.replaceChildren();
});

const base = {
	summary: '',
	repo: null,
	core: null,
	shape: null,
	legacy: null,
	blockers: []
};

const verified: CorpusResult = {
	...base,
	id: 'good',
	name: 'good',
	title: 'Good Site',
	summary: 'A site that works.',
	core: '^11.3',
	shape: 'project',
	status: 'verified',
	install: { allowed: true },
	checks: { passed: 2, total: 3, unchecked: 0 },
	cells: {
		install: { state: 'inline' },
		'file rw': { state: 'inline' },
		'outbound http': { state: 'unsupported' }
	}
};

const refused: CorpusResult = {
	...base,
	id: 'refused_one',
	name: 'refused_one',
	title: 'Refused One',
	repo: 'https://github.com/acme/refused',
	shape: 'module',
	status: 'unsupported',
	install: { allowed: false, reason: 'No composer.json.' },
	checks: { passed: 0, total: 3, unchecked: 0 },
	blockers: [{ checks: ['Install'], reason: 'No composer.json.' }],
	cells: { install: { state: 'unsupported' } }
};

const withLegacy: CorpusResult = {
	...refused,
	id: 'old',
	name: 'old',
	title: 'Old Site',
	status: 'partial',
	legacy: { date: '2026-11-08', baseOnly: true },
	checks: { passed: 8, total: 13, unchecked: 0 }
};

describe('RepoCorpusList', () => {
	it('shows the title and summary and never the machine name', async () => {
		const wrapper = await mountSuspended(List, { props: { items: [verified, refused] } });
		const text = wrapper.text();

		expect(text).toContain('Good Site');
		expect(text).toContain('A site that works.');
		expect(text).toContain('Drupal 11.3, Full Site');
		expect(text).not.toContain('refused_one');
	});

	it('words the status and counts the checks', async () => {
		const wrapper = await mountSuspended(List, { props: { items: [verified, refused] } });
		const text = wrapper.text();

		expect(text).toContain('Verified');
		expect(text).toContain('Unsupported');
		expect(text).toContain('2 of 3 checks pass');
	});

	it('says when the result comes from the legacy layer', async () => {
		const wrapper = await mountSuspended(List, { props: { items: [withLegacy] } });

		expect(wrapper.text()).toContain('8 of 13 checks pass with the legacy layer');
		expect(wrapper.text()).not.toContain('Needs Upgrade');
	});

	it('says a codebase that needs the legacy layer has not been run, not that nothing passes', async () => {
		const wrapper = await mountSuspended(List, {
			props: {
				items: [
					{
						...refused,
						status: 'needs upgrade',
						checks: { passed: 0, total: 13, unchecked: 0 }
					}
				]
			}
		});

		expect(wrapper.text()).toContain('Not run with the legacy layer yet');
		expect(wrapper.text()).not.toContain('0 of 13');
	});

	it('asks for the details of the codebase that was picked', async () => {
		const wrapper = await mountSuspended(List, { props: { items: [verified] } });

		await wrapper.find('button').trigger('click');

		expect(wrapper.emitted('inspect')?.[0]).toEqual([verified]);
	});
});

describe('RepoCorpusCells', () => {
	it('names each check with its state in words', async () => {
		const wrapper = await mountSuspended(Cells, {
			props: { rows: ROWS, cells: verified.cells }
		});
		const text = wrapper.text();

		expect(text).toContain('Install');
		expect(text).toContain('File Read and Write');
		expect(text).toContain('Not Supported');
	});

	it('shows a row with no cell as not checked', async () => {
		const wrapper = await mountSuspended(Cells, { props: { rows: ['update'], cells: {} } });

		expect(wrapper.text()).toContain('Not Checked');
	});
});

describe('RepoInstallDialog', () => {
	it('gives the reason a codebase fails in plain words and still offers a way to use it', async () => {
		await mountSuspended(Dialog, { props: { entry: refused, rows: ROWS, open: true } });
		const text = document.body.textContent ?? '';

		expect(text).toContain('No composer.json.');
		expect(text).toContain('Not verified does not mean blocked');
		expect(text).toContain('Add It to a Site');
	});

	it('says a whole site cannot be built from a repository yet and offers the upload instead', async () => {
		await mountSuspended(Dialog, { props: { entry: verified, rows: ROWS, open: true } });
		const text = document.body.textContent ?? '';

		expect(text).toContain('Create a Site From It');
		expect(text).toContain('Building a whole site from a repository is not running yet.');
		expect(text).toContain('Upload Its Files to a Site');
		expect(text).not.toContain('Not verified does not mean blocked');
	});

	it('says the legacy run covered the base site only', async () => {
		await mountSuspended(Dialog, { props: { entry: withLegacy, rows: ROWS, open: true } });
		const text = document.body.textContent ?? '';

		expect(text).toContain('legacy layer on 2026-11-08');
		expect(text).toContain('base site only');
	});

	it('links to the repository', async () => {
		await mountSuspended(Dialog, { props: { entry: refused, rows: ROWS, open: true } });

		const link = document.body.querySelector('a[href="https://github.com/acme/refused"]');
		expect(link).not.toBeNull();
	});
});

describe('RepoOwnDialog', () => {
	it('offers code that is not on the list and says what is not possible yet', async () => {
		await mountSuspended(OwnDialog, { props: { open: true } });
		const text = document.body.textContent ?? '';

		for (const label of [
			'Upload Files to a Site',
			'Attach a Repository',
			'Upload Your Own Worker',
			'Use a Public Git Address'
		]) {
			expect(text).toContain(label);
		}
		expect(text).toContain('connected account first');
		expect(document.body.querySelector('a[href="/new/custom"]')).not.toBeNull();
		expect(document.body.querySelector('a[href="/org/integrations"]')).not.toBeNull();
	});
});

describe('RepoSearch', () => {
	it('reports the search text as it is typed', async () => {
		const wrapper = await mountSuspended(Search, {
			props: { q: '', status: 'all' }
		});

		await wrapper.find('input').setValue('dr');

		expect(wrapper.emitted('update:q')?.at(-1)).toEqual(['dr']);
	});
});
