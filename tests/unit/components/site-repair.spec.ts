import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import Log from '~/components/health/repair/Log.vue';
import Row from '~/components/health/repair/Row.vue';
import Undo from '~/components/health/repair/Undo.vue';
import type { RepairList, RepairView } from '~/stores/repairs';

const repair = (overrides: Partial<RepairView> = {}): RepairView => ({
	id: 'rpr_1',
	title: 'Blank Page Fixed',
	status: 'succeeded',
	statusText: 'Fixed',
	createdAt: '2026-11-01T12:00:00.000Z',
	before: 'Pages came back blank.',
	after: 'Checked again. The problem is gone.',
	canUndo: false,
	undoReason: 'This repair cannot be undone.',
	isUndo: false,
	...overrides
});

const list = (items: RepairView[], extra: Partial<RepairList> = {}): RepairList => ({
	items,
	nextCursor: null,
	status: 'ready',
	error: null,
	...extra
});

const mounted: { unmount: () => void }[] = [];

afterEach(() => {
	for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

async function mountLog(
	props: Partial<{
		list: RepairList | undefined;
		undoing: string | null;
		undoError: string | null;
	}>
) {
	const wrapper = await mountSuspended(Log, {
		props: { list: undefined, undoing: null, undoError: null, ...props }
	});
	mounted.push(wrapper);
	return wrapper;
}

describe('the repair log', () => {
	it('says there are no repairs yet when the list is empty', async () => {
		const wrapper = await mountLog({ list: list([]) });
		expect(wrapper.text()).toContain('No automatic repairs yet');
	});

	it('shows the loading line while the first page is on its way', async () => {
		const wrapper = await mountLog({ list: list([], { status: 'loading' }) });
		expect(wrapper.text()).toContain('Loading repairs');
	});

	it('shows a failure with the message and no list', async () => {
		const wrapper = await mountLog({
			list: list([], {
				status: 'error',
				error: { status: 500, message: 'Try later.' } as never
			})
		});
		expect(wrapper.text()).toContain('The Repairs Could Not Be Loaded');
		expect(wrapper.text()).not.toContain('No automatic repairs yet');
	});

	it('shows the failed repair with its status text, before and after words', async () => {
		const wrapper = await mountLog({
			list: list([
				repair({
					status: 'failed',
					statusText: 'Not Fixed',
					after: 'Checked again. The problem is still there.'
				})
			])
		});
		expect(wrapper.text()).toContain('Not Fixed');
		expect(wrapper.text()).toContain('Pages came back blank.');
		expect(wrapper.text()).toContain('Checked again. The problem is still there.');
	});
});

describe('a repair row', () => {
	it('offers Undo when the repair allows it', async () => {
		const wrapper = await mountSuspended(Row, {
			props: { repair: repair({ canUndo: true, undoReason: null }), undoing: false }
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('Undo Repair');
	});

	it('shows the plain reason and no Undo button when the repair cannot be undone', async () => {
		const wrapper = await mountSuspended(Row, {
			props: { repair: repair(), undoing: false }
		});
		mounted.push(wrapper);
		expect(wrapper.text()).not.toContain('Undo Repair');
		expect(wrapper.text()).toContain('This repair cannot be undone.');
	});
});

describe('the undo control', () => {
	it('asks for confirmation before it emits anything', async () => {
		const wrapper = await mountSuspended(Undo, {
			props: { repair: repair({ canUndo: true, undoReason: null }), busy: false }
		});
		mounted.push(wrapper);
		const start = wrapper.findAll('button').find((b) => b.text() === 'Undo Repair');
		expect(start).toBeDefined();
		await start?.trigger('click');
		expect(wrapper.text()).toContain('Undo this repair?');
		expect(wrapper.emitted('confirm')).toBeUndefined();
		const confirm = wrapper.findAll('button').find((b) => b.text() === 'Confirm Undo');
		await confirm?.trigger('click');
		expect(wrapper.emitted('confirm')?.[0]?.[0]).toMatchObject({ id: 'rpr_1' });
	});
});
