import { mountSuspended } from '@nuxt/test-utils/runtime';
import { describe, expect, it } from 'vitest';
import Cells from '~/components/repo/corpus/Cells.vue';
import Table from '~/components/repo/corpus/Table.vue';
import Dialog from '~/components/repo/install/Dialog.vue';
import Search from '~/components/repo/Search.vue';
import type { CorpusResult } from '~/shared/corpus';

const ROWS = ['install', 'file rw', 'outbound http'];

const verified: CorpusResult = {
	id: 'good',
	name: 'good',
	status: 'verified',
	install: { allowed: true },
	cells: {
		install: { state: 'inline' },
		'file rw': { state: 'inline' },
		'outbound http': { state: 'unsupported' }
	}
};

const refused: CorpusResult = {
	id: 'refused',
	name: 'refused',
	status: 'unsupported',
	install: { allowed: false, reason: 'refused: no composer.json' },
	cells: { install: { state: 'unsupported' } }
};

describe('RepoCorpusTable', () => {
	it('shows a verified codebase as allowed and a refused one with its reason', async () => {
		const wrapper = await mountSuspended(Table, {
			props: { items: [verified, refused], rows: ROWS }
		});
		const text = wrapper.text();

		expect(text).toContain('Verified');
		expect(text).toContain('Allowed');
		expect(text).toContain('Unsupported');
		expect(text).toContain('Refused');
		expect(text).toContain('refused: no composer.json');
	});

	it('asks for the install options of the codebase that was picked', async () => {
		const wrapper = await mountSuspended(Table, {
			props: { items: [verified], rows: ROWS }
		});

		await wrapper.find('button').trigger('click');

		expect(wrapper.emitted('inspect')?.[0]).toEqual([verified]);
	});
});

describe('RepoCorpusCells', () => {
	it('names each capability row with its state in words', async () => {
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
	it('lists the four install modes and says which are not available yet', async () => {
		await mountSuspended(Dialog, { props: { entry: refused, open: true } });
		const text = document.body.textContent ?? '';

		for (const label of ['Whole Site', 'One Module', 'Change a Module', 'Temporary Copy']) {
			expect(text).toContain(label);
		}
		expect(text.match(/Not Available Yet/g)).toHaveLength(3);
	});

	it('gives the corpus refusal reason for the picked codebase', async () => {
		await mountSuspended(Dialog, { props: { entry: refused, open: true } });

		expect(document.body.textContent).toContain('refused: no composer.json');
	});

	it('states that a verified codebase can be installed', async () => {
		await mountSuspended(Dialog, { props: { entry: verified, open: true } });

		expect(document.body.textContent).toContain('verified and can be installed');
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
