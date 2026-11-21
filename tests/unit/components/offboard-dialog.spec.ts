import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OffboardDialog from '~/components/team/offboard/Dialog.vue';
import type { OffboardResult } from '~/shared/offboarding';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const ORG = 'org_personal';
const path = `/api/v1/orgs/${ORG}/members/mem_1/offboard`;

const plan = (over: Partial<OffboardResult> = {}): OffboardResult => ({
	dryRun: true,
	userId: 'usr_2',
	email: 'dev@example.test',
	effects: [
		{ kind: 'membership', ref: 'mem_1', label: 'dev@example.test (developer)' },
		{ kind: 'service-account-disable', ref: 'sa_1', label: 'Deploy Bot' },
		{ kind: 'delegation', ref: 'dg_1', label: 'Agency access (viewer)' }
	],
	kept: [],
	...over
});

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

async function mount() {
	const wrapper = await mountSuspended(OffboardDialog, {
		props: {
			orgId: ORG,
			memberId: 'mem_1',
			memberName: 'dev@example.test',
			candidates: [{ userId: 'usr_3', label: 'Heir' }],
			open: true
		},
		attachTo: document.body
	});
	mounted.push(wrapper);
	return wrapper;
}

const button = (label: string) =>
	[...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('offboard dialog', () => {
	it('lists what will happen from a dry run and changes nothing yet', async () => {
		signIn(null);
		cleanup = registerApi({ [`POST ${path}`]: { body: plan() } });
		await mount();
		await vi.waitFor(() => expect(document.body.textContent).toContain('Deploy Bot'));
		expect(document.body.textContent).toContain('Disable a service account: Deploy Bot');
		expect(document.body.textContent).toContain('End agency access they created');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toEqual({ dryRun: true });
	});

	it('asks for a fresh sign-in before it runs for real', async () => {
		signIn(null);
		cleanup = registerApi({ [`POST ${path}`]: { body: plan() } });
		await mount();
		await vi.waitFor(() => expect(document.body.textContent).toContain('Deploy Bot'));
		button('Offboard')!.click();
		await vi.waitFor(() => expect(document.body.textContent).not.toContain('Nothing changes'));
		expect(calls.every((c) => (c.body as { dryRun?: boolean }).dryRun === true)).toBe(true);
	});

	it('runs for real with a fresh sign-in and says how many changes were made', async () => {
		signIn(new Date(Date.now() + 60_000).toISOString());
		cleanup = registerApi({
			[`POST ${path}`]: (call) => ({
				body: (call.body as { dryRun?: boolean }).dryRun ? plan() : plan({ dryRun: false })
			})
		});
		const wrapper = await mount();
		await vi.waitFor(() => expect(document.body.textContent).toContain('Deploy Bot'));
		button('Offboard')!.click();
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain('is offboarded. 3 changes were made')
		);
		expect(calls.at(-1)?.body).toEqual({ dryRun: false });
		expect(wrapper.emitted('done')).toHaveLength(1);
	});

	it('plans again with the new owner and the keep choice', async () => {
		signIn(null);
		cleanup = registerApi({
			[`POST ${path}`]: {
				body: plan({
					kept: [{ kind: 'delegation', ref: 'dg_1', label: 'Agency access (viewer)' }]
				})
			}
		});
		await mount();
		await vi.waitFor(() => expect(document.body.textContent).toContain('Kept in place'));
		const box = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		box.click();
		await vi.waitFor(() => expect(calls.length).toBeGreaterThan(1));
		expect(calls.at(-1)?.body).toEqual({ dryRun: true, keepDelegations: true });
	});

	it('shows the server message when the plan is refused', async () => {
		signIn(null);
		cleanup = registerApi({
			[`POST ${path}`]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'An organization needs at least one owner',
					details: { reason: 'last_owner' },
					requestId: 'req_2'
				}
			}
		});
		await mount();
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain('An organization needs at least one owner')
		);
	});
});
