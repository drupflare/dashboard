import { mockComponent, mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import Add from '~/components/account/passkey/Add.vue';
import List from '~/components/account/passkey/List.vue';
import { usePasskeysStore } from '~/stores/passkeys';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const startRegistration = vi.hoisted(() => vi.fn());
vi.mock('@simplewebauthn/browser', () => ({ startRegistration }));

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

mockComponent('NuxtTurnstile', {
	props: { modelValue: String },
	setup(_props: unknown, { expose }: { expose: (value: object) => void }) {
		expose({ reset: () => undefined });
		return () => h('div');
	}
});

const WORK = {
	id: 'pk_1',
	name: 'Work Laptop',
	deviceType: 'multiDevice',
	backedUp: true,
	createdAt: '2026-11-01T10:00:00.000Z',
	lastUsedAt: '2026-11-05T10:00:00.000Z'
};
const DESK = {
	id: 'pk_2',
	name: 'Desk Key',
	deviceType: 'singleDevice',
	backedUp: false,
	createdAt: '2026-11-02T10:00:00.000Z',
	lastUsedAt: null
};
const listPath = 'GET /api/v1/me/passkeys';
const envelope = (status: number, code: string, message: string) => ({
	status,
	body: { code, message, details: {}, requestId: 'req_1' }
});
const stepUpEnvelope = {
	status: 403,
	body: {
		code: 'forbidden',
		message: 'Fresh authentication is required',
		details: { requires: 'step-up' },
		requestId: 'req_1'
	}
};

const soon = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

function signIn(stepUpUntil: string | null) {
	useSessionStore().me = {
		id: 'usr_1',
		email: 'owner@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil
	};
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const buttonIn = (root: ParentNode | null | undefined, text: string) =>
	[...(root?.querySelectorAll('button') ?? [])].find(
		(button) => button.textContent?.trim() === text
	);

const rowButton = (root: HTMLElement, name: string, text: string) =>
	buttonIn(
		[...root.querySelectorAll('li')].find((row) => row.textContent?.includes(name)),
		text
	);

async function mountWith(component: typeof List | typeof Add) {
	const wrapper = await mountSuspended(component, { attachTo: document.body });
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	navigate.mockReset();
	startRegistration.mockReset();
	clearBrowserState();
	useSessionStore().$reset();
	usePasskeysStore().$reset();
	signIn(soon());
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('passkey list', () => {
	it('shows a load error with the server message and a retry', async () => {
		cleanup = registerApi({
			[listPath]: envelope(500, 'internal', 'Passkeys are down')
		});
		const wrapper = await mountWith(List);
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain('Passkeys are down')
		);
		expect(wrapper.text()).toContain('Passkeys Could Not Load');
		expect(buttonIn(wrapper.element as HTMLElement, 'Try Again')).toBeDefined();
	});

	it('shows the empty state when the person has no passkeys', async () => {
		cleanup = registerApi({ [listPath]: { body: { items: [], nextCursor: null } } });
		const wrapper = await mountWith(List);
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Passkeys Yet'));
	});

	it('lists each passkey with its name', async () => {
		cleanup = registerApi({ [listPath]: { body: { items: [WORK, DESK], nextCursor: null } } });
		const wrapper = await mountWith(List);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Work Laptop'));
		expect(wrapper.text()).toContain('Desk Key');
		expect(wrapper.text()).toContain('Never used');
	});

	it('renames a passkey and shows the new name', async () => {
		cleanup = registerApi({
			[listPath]: { body: { items: [WORK], nextCursor: null } },
			'PATCH /api/v1/me/passkeys/pk_1': { status: 204, body: null }
		});
		const wrapper = await mountWith(List);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Work Laptop'));

		buttonIn(wrapper.element as HTMLElement, 'Rename')!.click();
		await nextTick();
		const input = wrapper.find<HTMLInputElement>('input[type="text"]');
		input.element.value = 'Desk Key';
		input.trigger('input');
		await nextTick();
		buttonIn(wrapper.element as HTMLElement, 'Save Name')!.click();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Desk Key'));
		expect(wrapper.text()).not.toContain('Work Laptop');
		expect(calls.at(-1)).toMatchObject({ method: 'PATCH', path: '/api/v1/me/passkeys/pk_1' });
		expect(calls.at(-1)?.body).toEqual({ name: 'Desk Key' });
	});

	it('removes a passkey after a plain confirmation', async () => {
		cleanup = registerApi({
			[listPath]: { body: { items: [WORK, DESK], nextCursor: null } },
			'DELETE /api/v1/me/passkeys/pk_2': { status: 204, body: null }
		});
		const wrapper = await mountWith(List);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Desk Key'));

		rowButton(wrapper.element as HTMLElement, 'Desk Key', 'Remove')!.click();
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		expect(dialog()!.textContent).toContain('Desk Key stops working for signing in.');
		expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

		buttonIn(dialog(), 'Remove Passkey')!.click();
		await vi.waitFor(() => expect(wrapper.text()).not.toContain('Desk Key'));
		expect(calls.find((call) => call.method === 'DELETE')?.path).toBe(
			'/api/v1/me/passkeys/pk_2'
		);
		expect(wrapper.text()).toContain('Work Laptop');
	});

	it('asks for a fresh sign-in before it removes a passkey when the session is stale', async () => {
		signIn(null);
		cleanup = registerApi({
			[listPath]: { body: { items: [DESK], nextCursor: null } },
			'DELETE /api/v1/me/passkeys/pk_2': stepUpEnvelope
		});
		const wrapper = await mountWith(List);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Desk Key'));

		rowButton(wrapper.element as HTMLElement, 'Desk Key', 'Remove')!.click();
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		buttonIn(dialog(), 'Remove Passkey')!.click();
		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm Your Identity'));
		expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
	});

	it('shows the server reason when the last sign-in method cannot be removed', async () => {
		cleanup = registerApi({
			[listPath]: { body: { items: [DESK], nextCursor: null } },
			'DELETE /api/v1/me/passkeys/pk_2': envelope(
				409,
				'conflict',
				'This is your last sign-in method, so it cannot be removed'
			)
		});
		const wrapper = await mountWith(List);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Desk Key'));

		buttonIn(wrapper.element as HTMLElement, 'Remove')!.click();
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		buttonIn(dialog(), 'Remove Passkey')!.click();

		await vi.waitFor(() =>
			expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
				'This is your last sign-in method, so it cannot be removed'
			)
		);
		expect(wrapper.text()).toContain('Desk Key');
	});
});

describe('add a passkey', () => {
	it('creates a passkey in two calls, then shows it in the list', async () => {
		const options = { challenge: 'abc', rp: { name: 'Drupflare' } };
		const response = { id: 'cred_9', rawId: 'cred_9', type: 'public-key', response: {} };
		startRegistration.mockResolvedValue(response);
		cleanup = registerApi({
			'POST /api/v1/me/passkeys/register': (call) =>
				(call.body as { phase: string }).phase === 'options'
					? { body: { options } }
					: { body: { passkey: { ...DESK, id: 'pk_9', name: 'Desk Key' } } },
			[listPath]: { body: { items: [DESK], nextCursor: null } }
		});
		const wrapper = await mountWith(Add);
		buttonIn(wrapper.element as HTMLElement, 'Add a Passkey')!.click();
		await vi.waitFor(() => expect(dialog()).not.toBeNull());

		const input = dialog()!.querySelector<HTMLInputElement>('input[type="text"]')!;
		input.value = 'Desk Key';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await nextTick();
		buttonIn(dialog(), 'Add Passkey')!.click();

		await vi.waitFor(() => expect(dialog()).toBeNull());
		expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: options });
		expect(calls.slice(0, 2).map((call) => call.body)).toEqual([
			{ phase: 'options' },
			{ phase: 'verify', response, name: 'Desk Key' }
		]);
		expect(usePasskeysStore().items).toEqual([DESK]);
	});

	it('keeps the dialog open with a calm line when the prompt is cancelled', async () => {
		startRegistration.mockRejectedValue(
			Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
		);
		cleanup = registerApi({
			'POST /api/v1/me/passkeys/register': { body: { options: { challenge: 'abc' } } }
		});
		const wrapper = await mountWith(Add);
		buttonIn(wrapper.element as HTMLElement, 'Add a Passkey')!.click();
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		buttonIn(dialog(), 'Add Passkey')!.click();

		await vi.waitFor(() => expect(dialog()?.textContent).toContain('No passkey was added.'));
		expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
		expect(
			calls.some(
				(call) =>
					call.path.endsWith('/register') &&
					call.body &&
					(call.body as { phase: string }).phase === 'verify'
			)
		).toBe(false);
	});

	it('asks for a fresh sign-in before it starts when the session is stale', async () => {
		signIn(null);
		cleanup = registerApi({
			'POST /api/v1/me/passkeys/register': stepUpEnvelope
		});
		const wrapper = await mountWith(Add);
		buttonIn(wrapper.element as HTMLElement, 'Add a Passkey')!.click();
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		buttonIn(dialog(), 'Add Passkey')!.click();

		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm Your Identity'));
		expect(calls).toHaveLength(0);
		expect(startRegistration).not.toHaveBeenCalled();
	});
});
