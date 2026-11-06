import { describe, expect, it } from 'vitest';
import { SITE_PLANES } from '../../../contracts/src/sites';
import {
	SWITCH_REFUSAL_CODES,
	chooseConfig,
	planSwitch,
	type ConfigFacts,
	type SwitchFacts
} from '../../../engine/src/config-choice';

const ATTACHED = [[], ['FILES'], ['SEND_EMAIL'], ['FILES', 'SEND_EMAIL', 'CONFIG_KV']];

function allFacts(): ConfigFacts[] {
	const out: ConfigFacts[] = [];
	for (const plane of SITE_PLANES) {
		for (const r2Enabled of [false, true]) {
			for (const emailBindingAccepted of [false, true]) {
				for (const attached of ATTACHED) {
					out.push({ plane, r2Enabled, emailBindingAccepted, attached });
				}
			}
		}
	}
	return out;
}

describe('chooseConfig', () => {
	it('answers every combination of facts with a config and at least one reason', () => {
		const facts = allFacts();
		expect(facts).toHaveLength(48);
		for (const item of facts) {
			const first = chooseConfig(item);
			expect(['managed', 'canonical']).toContain(first.config);
			expect(first.reasons.length).toBeGreaterThan(0);
			for (const reason of first.reasons) expect(reason.length).toBeGreaterThan(0);
			expect(chooseConfig(item)).toEqual(first);
		}
	});

	it('gives the managed plane the managed config whatever the probe said', () => {
		for (const item of allFacts().filter((f) => f.plane === 'managed')) {
			expect(chooseConfig(item).config).toBe('managed');
		}
	});

	it('gives an account with R2 and the email binding the managed config', () => {
		const choice = chooseConfig({
			plane: 'self-managed',
			r2Enabled: true,
			emailBindingAccepted: true,
			attached: []
		});
		expect(choice.config).toBe('managed');
	});

	it('gives an account without R2 the canonical config and names R2', () => {
		const choice = chooseConfig({
			plane: 'self-managed',
			r2Enabled: false,
			emailBindingAccepted: true,
			attached: []
		});
		expect(choice.config).toBe('canonical');
		expect(choice.reasons.join(' ')).toContain('R2');
	});

	it('gives an account without the email binding the canonical config and names it', () => {
		const choice = chooseConfig({
			plane: 'self-managed',
			r2Enabled: true,
			emailBindingAccepted: false,
			attached: []
		});
		expect(choice.config).toBe('canonical');
		expect(choice.reasons.join(' ')).toContain('email');
	});

	it('treats a binding already on the script as proof the account accepts it', () => {
		const choice = chooseConfig({
			plane: 'self-managed',
			r2Enabled: false,
			emailBindingAccepted: false,
			attached: ['FILES', 'SEND_EMAIL']
		});
		expect(choice.config).toBe('managed');
	});

	it('never picks managed off the managed plane without R2 and email evidence', () => {
		for (const item of allFacts().filter((f) => f.plane !== 'managed')) {
			const r2 = item.r2Enabled || item.attached.includes('FILES');
			const email = item.emailBindingAccepted || item.attached.includes('SEND_EMAIL');
			expect(chooseConfig(item).config).toBe(r2 && email ? 'managed' : 'canonical');
		}
	});
});

describe('planSwitch', () => {
	const limits = { objectStorageLimitBytes: 1000 };
	const facts = (patch: Partial<SwitchFacts> = {}): SwitchFacts => ({
		plane: 'self-managed',
		r2Enabled: true,
		emailBindingAccepted: true,
		attached: [],
		fileBytes: 400,
		objectStorageBytes: 100,
		...patch
	});
	const ids = (result: ReturnType<typeof planSwitch>) =>
		result.ok ? result.steps.map((s) => s.id) : [];
	const code = (result: ReturnType<typeof planSwitch>) =>
		result.ok ? null : result.refusal.code;

	it('moves to managed by creating the bucket, copying, verifying, then deploying', () => {
		const result = planSwitch('canonical', 'managed', facts(), limits);
		expect(ids(result)).toEqual([
			'create-bucket',
			'copy-files',
			'verify-files',
			'deploy-managed',
			'verify-site'
		]);
	});

	it('verifies the copy before it deploys, in both directions', () => {
		for (const [from, to] of [
			['canonical', 'managed'],
			['managed', 'canonical']
		] as const) {
			const order = ids(planSwitch(from, to, facts(), limits));
			expect(order.indexOf('copy-files')).toBeLessThan(order.indexOf('verify-files'));
			expect(order.indexOf('verify-files')).toBeLessThan(
				order.findIndex((id) => id.startsWith('deploy'))
			);
		}
	});

	it('moves to canonical when the bytes fit and refuses when they do not', () => {
		expect(planSwitch('managed', 'canonical', facts(), limits).ok).toBe(true);
		const exact = facts({ fileBytes: 900, objectStorageBytes: 100 });
		expect(planSwitch('managed', 'canonical', exact, limits).ok).toBe(true);
		const over = planSwitch(
			'managed',
			'canonical',
			facts({ fileBytes: 901, objectStorageBytes: 100 }),
			limits
		);
		expect(code(over)).toBe('exceeds_object_storage');
		expect(!over.ok && over.refusal.reason).toContain('1 over');
	});

	it('deletes the bucket last and only on the move to canonical', () => {
		const back = ids(planSwitch('managed', 'canonical', facts(), limits));
		expect(back.at(-1)).toBe('retire-bucket');
		expect(ids(planSwitch('canonical', 'managed', facts(), limits))).not.toContain(
			'retire-bucket'
		);
	});

	it('refuses a move to managed on an account without R2 or the email binding', () => {
		expect(code(planSwitch('canonical', 'managed', facts({ r2Enabled: false }), limits))).toBe(
			'account_lacks_r2'
		);
		const noEmail = facts({ emailBindingAccepted: false });
		expect(code(planSwitch('canonical', 'managed', noEmail, limits))).toBe(
			'account_lacks_email'
		);
		expect(
			planSwitch(
				'canonical',
				'managed',
				facts({ plane: 'managed', r2Enabled: false }),
				limits
			).ok
		).toBe(true);
	});

	it('refuses a move to the config the site already has', () => {
		expect(code(planSwitch('managed', 'managed', facts(), limits))).toBe('same_config');
	});

	it('refuses facts that are not whole byte counts', () => {
		for (const patch of [
			{ fileBytes: -1 },
			{ fileBytes: 1.5 },
			{ objectStorageBytes: Number.NaN }
		]) {
			expect(code(planSwitch('managed', 'canonical', facts(patch), limits))).toBe(
				'invalid_facts'
			);
		}
		expect(
			code(planSwitch('managed', 'canonical', facts(), { objectStorageLimitBytes: 0 }))
		).toBe('invalid_facts');
	});

	it('trips every refusal code it lists', () => {
		const raised = new Set([
			code(planSwitch('managed', 'managed', facts(), limits)),
			code(planSwitch('managed', 'canonical', facts({ fileBytes: -1 }), limits)),
			code(planSwitch('canonical', 'managed', facts({ r2Enabled: false }), limits)),
			code(
				planSwitch('canonical', 'managed', facts({ emailBindingAccepted: false }), limits)
			),
			code(planSwitch('managed', 'canonical', facts({ fileBytes: 5000 }), limits))
		]);
		expect([...raised].sort()).toEqual([...SWITCH_REFUSAL_CODES].sort());
	});
});
