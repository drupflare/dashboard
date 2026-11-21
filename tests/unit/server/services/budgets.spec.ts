import { describe, expect, it } from 'vitest';
import { FREE_PLAN_ID } from '../../../../src/server/domain/entitlements';
import {
	NOT_APPLICABLE,
	loosens,
	readOrgBudget,
	readSiteBudget,
	seedOrgBudgetFor,
	setOrgBudget,
	setSiteBudget
} from '../../../../src/server/services/budgets';
import { OVERSHOOT_BOUND_SENTENCE } from '../../../../src/shared/budget-rules';
import { ApiError } from '../../../../src/shared/errors';
import { ORG, world } from './budgets-support';

const orgChange = (percent: number, enforcement: 'block' | 'alert' = 'block') => ({
	orgId: ORG,
	actor: 'user:u1',
	fresh: false,
	change: { percent, enforcement }
});

describe('default budgets', () => {
	it('seeds a hard 500 percent budget on a paid plan', async () => {
		const w = world();
		expect(await seedOrgBudgetFor(w.services, ORG)).toBe('seeded');
		expect(w.rows).toHaveLength(1);
		expect(w.rows[0]).toMatchObject({ scope: 'org', percent: 500, enforcement: 'block' });
		expect(w.audits.map((a) => a.input.action)).toEqual(['budget.seed']);
	});

	it('seeds once and never overwrites the customer choice', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		await setOrgBudget(w.services, { ...orgChange(300, 'alert'), fresh: true });
		expect(await seedOrgBudgetFor(w.services, ORG)).toBe('kept');
		expect(w.rows[0]).toMatchObject({ percent: 300, enforcement: 'alert' });
		expect(w.audits.filter((a) => a.input.action === 'budget.seed')).toHaveLength(1);
	});

	it('writes nothing for a free organisation and answers not_applicable', async () => {
		const w = world({ plan: FREE_PLAN_ID });
		expect(await seedOrgBudgetFor(w.services, ORG)).toBe('not-applicable');
		expect(w.rows).toEqual([]);
		expect(await readOrgBudget(w.services, ORG)).toEqual(NOT_APPLICABLE);
		expect(await readSiteBudget(w.services, ORG, 'site-1')).toEqual(NOT_APPLICABLE);
		expect(await setOrgBudget(w.services, orgChange(300))).toEqual(NOT_APPLICABLE);
		expect(w.rows).toEqual([]);
	});

	it('seeds on the first read for an account activated before budgets existed', async () => {
		const w = world();
		const reply = await readOrgBudget(w.services, ORG);
		expect(reply).toMatchObject({
			status: 'ok',
			percent: 500,
			enforcement: 'block',
			ownerSet: false
		});
	});

	it('gives each site under a pooled allowance the default share until the owner sets one', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		const site = await readSiteBudget(w.services, ORG, 'site-1');
		expect(site).toMatchObject({ percent: 250, enforcement: 'block', ownerSet: false });
	});

	it('leaves a single site to the organisation budget', async () => {
		const w = world({ sites: ['site-1'] });
		await seedOrgBudgetFor(w.services, ORG);
		expect(await readSiteBudget(w.services, ORG, 'site-1')).toMatchObject({ percent: null });
	});
});

describe('raising and lowering', () => {
	it('lets the billing permission alone lower a budget', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		const reply = await setOrgBudget(w.services, orgChange(300));
		expect(reply).toMatchObject({ status: 'ok', percent: 300, changed: true });
	});

	it('needs a fresh session to raise a budget', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		await setOrgBudget(w.services, orgChange(300));
		const stale = setOrgBudget(w.services, orgChange(400));
		await expect(stale).rejects.toMatchObject({
			code: 'forbidden',
			details: { requires: 'step-up' }
		});
		expect(w.rows[0]?.percent).toBe(300);
		const raised = await setOrgBudget(w.services, { ...orgChange(400), fresh: true });
		expect(raised).toMatchObject({ percent: 400 });
	});

	it('treats block to alert as loosening and needs a fresh session', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		await expect(setOrgBudget(w.services, orgChange(500, 'alert'))).rejects.toBeInstanceOf(
			ApiError
		);
		expect(w.rows[0]?.enforcement).toBe('block');
		await setOrgBudget(w.services, { ...orgChange(500, 'alert'), fresh: true });
		expect(w.rows[0]?.enforcement).toBe('alert');
	});

	it('lets alert to block through without a fresh session', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		await setOrgBudget(w.services, { ...orgChange(500, 'alert'), fresh: true });
		await setOrgBudget(w.services, orgChange(500, 'block'));
		expect(w.rows[0]?.enforcement).toBe('block');
	});

	it('names the rule in one place', () => {
		const hard = { percent: 500, enforcement: 'block' as const };
		expect(loosens(hard, { percent: 501, enforcement: 'block' })).toBe(true);
		expect(loosens(hard, { percent: 500, enforcement: 'alert' })).toBe(true);
		expect(loosens(hard, { percent: 400, enforcement: 'block' })).toBe(false);
		expect(
			loosens({ percent: 500, enforcement: 'alert' }, { percent: 500, enforcement: 'block' })
		).toBe(false);
		expect(loosens(null, hard)).toBe(false);
	});

	it('refuses a percent the slider would never offer, with a plain reason', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		await expect(setOrgBudget(w.services, orgChange(50))).rejects.toMatchObject({
			code: 'validation',
			message: 'The lowest budget is 100 percent, which is the allowance itself.'
		});
		await expect(setOrgBudget(w.services, orgChange(250.55))).rejects.toMatchObject({
			code: 'validation'
		});
	});

	it('changes nothing and audits nothing when the budget is the same', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		const reply = await setOrgBudget(w.services, orgChange(500));
		expect(reply).toMatchObject({ changed: false });
		expect(w.audits.map((a) => a.input.action)).toEqual(['budget.seed']);
		expect(w.reevaluated()).toEqual([]);
	});
});

describe('audit and re-evaluation', () => {
	it('writes the old and new values for every change', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		await setOrgBudget(w.services, orgChange(300));
		const row = w.audits.at(-1);
		expect(row?.orgId).toBe(ORG);
		expect(row?.input).toEqual({
			actor: 'user:u1',
			action: 'budget.set',
			target: ORG,
			detail: {
				scope: 'org',
				old: { percent: 500, enforcement: 'block' },
				new: { percent: 300, enforcement: 'block' }
			}
		});
		expect(w.rows[0]?.setBy).toBe('user:u1');
	});

	it('re-evaluates the organisation after a raise and after a lowering', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		await setOrgBudget(w.services, orgChange(300));
		await setOrgBudget(w.services, { ...orgChange(900), fresh: true });
		expect(w.reevaluated()).toEqual([ORG, ORG]);
	});

	it('still saves the budget when the evaluation is not installed', async () => {
		const w = world({ enforcement: false });
		await seedOrgBudgetFor(w.services, ORG);
		const reply = await setOrgBudget(w.services, orgChange(300));
		expect(reply).toMatchObject({ percent: 300 });
	});

	it('answers with the bound sentence and never the word instantly', async () => {
		const w = world();
		const reply = await readOrgBudget(w.services, ORG);
		expect(reply).toMatchObject({
			appliesWithin: OVERSHOOT_BOUND_SENTENCE,
			enforcementFlag: 'shadow',
			accounting: 'counted'
		});
		expect(JSON.stringify(reply)).not.toMatch(/instant/i);
	});
});

describe('site budgets', () => {
	it('refuses a site percent above the organisation percent', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		await expect(
			setSiteBudget(w.services, { ...orgChange(600), siteId: 'site-1', fresh: true })
		).rejects.toMatchObject({
			code: 'validation',
			message: 'A site budget cannot be higher than the organisation budget of 500 percent.'
		});
	});

	it('stores a site budget, audits it and re-evaluates', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		const reply = await setSiteBudget(w.services, {
			...orgChange(200, 'alert'),
			siteId: 'site-1',
			fresh: true
		});
		expect(reply).toMatchObject({
			scope: 'site',
			percent: 200,
			enforcement: 'alert',
			ownerSet: true
		});
		expect(w.audits.at(-1)?.input).toMatchObject({
			action: 'budget.set',
			target: 'site-1',
			detail: { scope: 'site', old: { percent: 250, enforcement: 'block' } }
		});
		expect(w.reevaluated()).toEqual([ORG]);
	});

	it('needs a fresh session to raise a site budget', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		await setSiteBudget(w.services, { ...orgChange(200), siteId: 'site-1' });
		await expect(
			setSiteBudget(w.services, { ...orgChange(300), siteId: 'site-1' })
		).rejects.toMatchObject({ details: { requires: 'step-up' } });
	});

	it('answers not_found for a site the organisation does not hold', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		await expect(readSiteBudget(w.services, ORG, 'site-9')).rejects.toMatchObject({
			code: 'not_found'
		});
		await expect(
			setSiteBudget(w.services, { ...orgChange(200), siteId: 'site-9' })
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('clamps a stored site percent to a lowered organisation percent when it reads', async () => {
		const w = world();
		await seedOrgBudgetFor(w.services, ORG);
		await setSiteBudget(w.services, { ...orgChange(240), siteId: 'site-1' });
		expect(w.rows.filter((row) => row.scope === 'site')).toHaveLength(1);
		await setOrgBudget(w.services, orgChange(150));
		expect(await readSiteBudget(w.services, ORG, 'site-1')).toMatchObject({ percent: 150 });
	});
});
