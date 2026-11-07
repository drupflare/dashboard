import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import Typed from '~/components/ui/confirm/Typed.vue';

const NAME = 'quiet-oak-harbor';
const mounted: { unmount: () => void }[] = [];
const outside: HTMLElement[] = [];

async function mountTyped(props: Record<string, unknown> = {}) {
	const wrapper = await mountSuspended(Typed, {
		props: { expected: NAME, label: 'Site Name', action: 'Delete Site', ...props },
		attachTo: document.body
	});
	mounted.push(wrapper);
	return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountTyped>>;

const confirmButton = (wrapper: Wrapper) =>
	wrapper.findAll('button').find((button) => button.text() === 'Delete Site')!;
const cancelButton = (wrapper: Wrapper) =>
	wrapper.findAll('button').find((button) => button.text() === 'Cancel')!;

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	outside.splice(0).forEach((element) => element.remove());
});

describe('typed confirmation', () => {
	it('labels the field and shows the name to type', async () => {
		const wrapper = await mountTyped();
		const input = wrapper.find('input');
		const label = wrapper.find(`label[for="${input.attributes('id')}"]`);
		expect(label.text()).toBe('Site Name');
		expect(wrapper.text()).toContain(`Type ${NAME} to continue.`);
		expect(input.attributes('aria-describedby')).toBeTruthy();
	});

	it('keeps the confirm button disabled until the text matches exactly', async () => {
		const wrapper = await mountTyped();
		expect(confirmButton(wrapper).attributes('disabled')).toBeDefined();
		for (const wrong of ['quiet-oak', 'Quiet-Oak-Harbor', `${NAME} `, ` ${NAME}`]) {
			await wrapper.find('input').setValue(wrong);
			expect(confirmButton(wrapper).attributes('disabled'), wrong).toBeDefined();
		}
		await wrapper.find('input').setValue(NAME);
		expect(confirmButton(wrapper).attributes('disabled')).toBeUndefined();
	});

	it('does not confirm on Enter while the text differs, and confirms once when it matches', async () => {
		const wrapper = await mountTyped();
		await wrapper.find('input').setValue('quiet-oak');
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('confirm')).toBeUndefined();

		await wrapper.find('input').setValue(NAME);
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('confirm')).toHaveLength(1);
	});

	it('says what is wrong beside the field once the person leaves it, and clears it on a match', async () => {
		const wrapper = await mountTyped();
		await wrapper.find('input').setValue('quiet-oak');
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);

		await wrapper.find('input').trigger('blur');
		const alert = wrapper.find('[role="alert"]');
		expect(alert.text()).toContain('does not match');
		expect(wrapper.find('input').attributes('aria-invalid')).toBe('true');

		await wrapper.find('input').setValue(NAME);
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
		expect(wrapper.find('input').attributes('aria-invalid')).toBeUndefined();
	});

	it('shows no error for an empty field, even after blur', async () => {
		const wrapper = await mountTyped();
		await wrapper.find('input').trigger('blur');
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
	});

	it('does not confirm while busy', async () => {
		const wrapper = await mountTyped({ busy: true });
		await wrapper.find('input').setValue(NAME);
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('confirm')).toBeUndefined();
		expect(confirmButton(wrapper).attributes('disabled')).toBeDefined();
	});

	it('emits cancel and returns focus to the element that opened it', async () => {
		const trigger = document.createElement('button');
		trigger.textContent = 'Open';
		document.body.append(trigger);
		outside.push(trigger);
		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		const wrapper = await mountTyped();
		(wrapper.find('input').element as HTMLInputElement).focus();
		expect(document.activeElement).not.toBe(trigger);

		await cancelButton(wrapper).trigger('click');
		expect(wrapper.emitted('cancel')).toHaveLength(1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.activeElement).toBe(trigger);
	});
});
