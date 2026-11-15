import { mockComponent, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import Revoke from '~/components/plane/Revoke.vue';
import type { PlaneConnectionView } from '~/shared/plane-connections';
import { usePlanesStore } from '~/stores/planes';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

mockComponent('NuxtTurnstile', {
	props: { modelValue: String },
	setup(_props: unknown, { expose }: { expose: (value: object) => void }) {
		expose({ reset: () => undefined });
		return () => h('div');
	}
});

const ORG = 'org_personal';
const ID = 'pcn_1';
const path = `DELETE /api/v1/orgs/${ORG}/planes/cloudflare/${ID}`;

const connection: PlaneConnectionView = {
	id: ID,
	provider: 'cloudflare',
	accountId: 'a'.repeat(32),
	accountName: 'Campus Site',
	tokenKind: 'user',
	expiresOn: null,
	state: 'active',
	capabilities: [],
	workersSubdomain: 'acme',
	narrowerToken: true,
	createdAt: 1,
	lastValidatedAt: 2,
	revokedAt: null
};

const revoked = { ...connection, state: 'revoked', revokedAt: 3 };
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

async function mountRevoke() {
	const wrapper = await mountSuspended(Revoke, {
		props: { orgId: ORG, connection },
		attachTo: document.body
	});
	mounted.push(wrapper);
	return wrapper;
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const inDialog = (text: string) =>
	[...(dialog()?.querySelectorAll('button') ?? [])].find(
		(button) => button.textContent?.trim() === text
	);

async function openDialog(wrapper: Awaited<ReturnType<typeof mountRevoke>>) {
	await wrapper.find('button').trigger('click');
	await vi.waitFor(() => expect(dialog()).not.toBeNull());
}

async function typeName(text: string) {
	const input = dialog()!.querySelector<HTMLInputElement>('input[type="text"]')!;
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await nextTick();
}

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	usePlanesStore().$reset();
	signIn(soon());
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('revoke a Cloudflare connection', () => {
	it('says what happens to the token and the sites before it asks for the account name', async () => {
		cleanup = registerApi({
			[path]: { body: { connection: revoked, tokenRemoval: 'not-ours', message: 'Done.' } }
		});
		const wrapper = await mountRevoke();
		await openDialog(wrapper);
		const text = dialog()!.textContent ?? '';
		expect(text).toContain('wipes the stored token');
		expect(text).toContain('keep serving');
		expect(inDialog('Revoke Connection')?.hasAttribute('disabled')).toBe(true);
	});

	it('revokes once the account name matches and shows what Cloudflare did with the token', async () => {
		cleanup = registerApi({
			[path]: {
				body: {
					connection: revoked,
					tokenRemoval: 'owner-must-delete',
					message:
						'The stored token is wiped. Delete the token named "Drupflare site connection pcn_1".'
				}
			}
		});
		const wrapper = await mountRevoke();
		await openDialog(wrapper);
		await typeName('Campus');
		expect(inDialog('Revoke Connection')?.hasAttribute('disabled')).toBe(true);
		await typeName('Campus Site');
		inDialog('Revoke Connection')!.click();
		await vi.waitFor(() =>
			expect(dialog()?.textContent).toContain(
				'Delete the token named "Drupflare site connection pcn_1"'
			)
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe(`/api/v1/orgs/${ORG}/planes/cloudflare/${ID}`);
		expect(usePlanesStore().connections.get(ORG)?.[0]?.state).toBe('revoked');
	});

	it('lists the sites that still run on the account and revokes only after the owner agrees', async () => {
		let attempt = 0;
		cleanup = registerApi({
			[path]: (call) => {
				attempt++;
				if (call.query.force === undefined) {
					return {
						status: 409,
						body: {
							code: 'conflict',
							message: 'Sites still run on this account.',
							details: {
								reason: 'sites_use_connection',
								siteIds: ['site_one', 'site_two']
							},
							requestId: 'req_1'
						}
					};
				}
				return {
					body: { connection: revoked, tokenRemoval: 'not-ours', message: 'Revoked.' }
				};
			}
		});
		const wrapper = await mountRevoke();
		await openDialog(wrapper);
		await typeName('Campus Site');
		inDialog('Revoke Connection')!.click();
		await vi.waitFor(() => expect(dialog()?.textContent).toContain('site_one'));
		expect(dialog()?.textContent).toContain('site_two');
		expect(inDialog('Revoke Connection')?.hasAttribute('disabled')).toBe(true);
		const box = dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		box.click();
		await nextTick();
		expect(inDialog('Revoke Connection')?.hasAttribute('disabled')).toBe(false);
		inDialog('Revoke Connection')!.click();
		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Revoked.'));
		expect(attempt).toBe(2);
		expect(calls.at(-1)?.query.force).toBe('site_one,site_two');
	});

	it('asks for a fresh sign-in before it sends anything', async () => {
		signIn(null);
		cleanup = registerApi({
			[path]: { body: { connection: revoked, tokenRemoval: 'not-ours', message: 'Done.' } }
		});
		const wrapper = await mountRevoke();
		await openDialog(wrapper);
		await typeName('Campus Site');
		inDialog('Revoke Connection')!.click();
		await nextTick();
		expect(calls).toHaveLength(0);
		await vi.waitFor(() => expect(dialog()?.textContent).toContain('Confirm'));
	});

	it('shows another refusal inside the dialog and keeps it open', async () => {
		cleanup = registerApi({
			[path]: {
				status: 500,
				body: {
					code: 'internal',
					message: 'Could not revoke.',
					details: {},
					requestId: 'req_2'
				}
			}
		});
		const wrapper = await mountRevoke();
		await openDialog(wrapper);
		await typeName('Campus Site');
		inDialog('Revoke Connection')!.click();
		await vi.waitFor(() =>
			expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
				'Could not revoke.'
			)
		);
		expect(dialog()).not.toBeNull();
	});
});
