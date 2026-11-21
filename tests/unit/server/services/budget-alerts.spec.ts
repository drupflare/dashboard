import { describe, expect, it } from 'vitest';
import { renderMail, type MailInput } from '../../../../src/server/emails';
import {
	budgetAlertSink,
	type AlertRecipient,
	type BudgetAlertDeps
} from '../../../../src/server/services/budget-alerts';
import {
	evaluateOrganization,
	type AlertNotice,
	type BudgetEnforcementDeps,
	type StateRecord
} from '../../../../src/server/services/budget-enforcement';
import type { AlertKey } from '../../../../src/shared/budget-rules';

const ORG = 'org-1';
const PERIOD = '2026-11';

interface Sent {
	to: string;
	input: Extract<MailInput, { kind: 'budget-alert' }>;
	category: string;
}

// the claim table outlives a sink, so building a second sink over it is a restart
function world(
	options: {
		recipients?: AlertRecipient[];
		remaining?: number;
		failMail?: boolean;
		secret?: boolean;
		paused?: boolean;
	} = {}
) {
	const claims = new Set<string>();
	const sent: Sent[] = [];
	const counted: string[] = [];
	const recorded: string[] = [];
	const logs: string[] = [];
	const owner: AlertRecipient = { email: 'owner@example.test', userId: 'u1', prefs: {} };
	const optedIn: AlertRecipient = {
		email: 'billing@example.test',
		userId: null,
		prefs: { 'billing-info': true }
	};
	const recipients = options.recipients ?? [owner, optedIn];
	const sink = (secret = options.secret ?? true) =>
		budgetAlertSink({
			now: () => Date.UTC(2026, 10, 21),
			log: (message) => logs.push(message),
			paused: async () => options.paused ?? false,
			record: async (category, status) => {
				recorded.push(`${category}:${status}`);
			},
			remaining: async () => options.remaining ?? 1000,
			recordSent: async (category) => {
				counted.push(category);
			},
			sent: async (_org, period) =>
				[...claims]
					.map((key) => key.split('|') as [string, string, string])
					.filter(([, p]) => p === period)
					.map(([scopeKey, , alertKey]) => ({ scopeKey, alertKey })),
			claim: async (_org, scopeKey, period, alertKey) => {
				const key = `${scopeKey}|${period}|${alertKey}`;
				if (claims.has(key)) return false;
				claims.add(key);
				return true;
			},
			release: async (_org, scopeKey, period, alertKey) => {
				claims.delete(`${scopeKey}|${period}|${alertKey}`);
			},
			recipients: async () => recipients,
			names: async (_org, siteId) => ({
				orgName: 'Acme',
				siteName: siteId ? 'Main site' : null
			}),
			...(secret
				? { unsubscribeUrl: async () => 'https://app.example.test/unsubscribe/x' }
				: {}),
			budgetUrl: () => 'https://app.example.test/billing',
			send: async (to, input) => {
				if (options.failMail) throw new Error('mail is down');
				if (input.kind !== 'budget-alert') throw new Error('unexpected mail');
				sent.push({ to, input, category: renderMail(input).category });
			}
		} satisfies BudgetAlertDeps);
	return { sink, sent, claims, logs, counted, recorded };
}

const notice = (alerts: AlertKey[], over: Partial<AlertNotice> = {}): AlertNotice => ({
	orgId: ORG,
	siteId: null,
	period: PERIOD,
	alerts,
	budget: { percent: 500, enforcement: 'block' },
	allowanceViews: 1000,
	views: 760,
	mode: 'on',
	...over
});

describe('alert idempotence', () => {
	it('sends each alert once in a period, also across a restart', async () => {
		const w = world();
		await w.sink().notify(notice(['allowance-75']));
		const before = w.sent.length;
		expect(before).toBeGreaterThan(0);
		// the evaluation asks which alerts are recorded, so a second run offers nothing new
		expect(await w.sink().sent(ORG, null, PERIOD)).toEqual([
			{ key: 'allowance-75', period: PERIOD }
		]);
		await w.sink().notify(notice(['allowance-75']));
		expect(w.sent).toHaveLength(before);
	});

	it('sends the same alert again in a new period', async () => {
		const w = world();
		await w.sink().notify(notice(['allowance-75']));
		const first = w.sent.length;
		await w.sink().notify(notice(['allowance-75'], { period: '2026-12' }));
		expect(w.sent).toHaveLength(first * 2);
	});

	it('keeps the organisation and each site apart', async () => {
		const w = world();
		await w.sink().notify(notice(['allowance-75']));
		expect(await w.sink().sent(ORG, 'site-1', PERIOD)).toEqual([]);
		await w.sink().notify(notice(['allowance-75'], { siteId: 'site-1' }));
		expect(await w.sink().sent(ORG, 'site-1', PERIOD)).toHaveLength(1);
	});

	it('gives the claim back when no mail could be delivered, so the next run tries again', async () => {
		const w = world({ failMail: true });
		await w.sink().notify(notice(['budget-90']));
		expect(w.claims.size).toBe(0);
	});
});

describe('classes and recipients', () => {
	it('sends the 90 percent budget notice and the block notice as essential mail to every recipient', async () => {
		const w = world();
		await w.sink().notify(notice(['budget-90', 'blocked']));
		expect(w.sent.map((s) => `${s.input.alert}:${s.category}:${s.to}`).sort()).toEqual([
			'blocked:budget-limit:billing@example.test',
			'blocked:budget-limit:owner@example.test',
			'budget-90:budget-limit:billing@example.test',
			'budget-90:budget-limit:owner@example.test'
		]);
		expect(w.sent.every((s) => s.input.unsubscribeUrl === undefined)).toBe(true);
	});

	it('sends the allowance alerts as billing-info to opted-in recipients only', async () => {
		const w = world();
		await w.sink().notify(notice(['allowance-75', 'allowance-100']));
		expect(w.sent.map((s) => `${s.input.alert}:${s.category}:${s.to}`).sort()).toEqual([
			'allowance-100:billing-info:billing@example.test',
			'allowance-75:billing-info:billing@example.test'
		]);
		expect(w.sent.every((s) => s.input.unsubscribeUrl !== undefined)).toBe(true);
		for (const s of w.sent)
			expect(renderMail(s.input).headers).toHaveProperty('List-Unsubscribe');
	});

	it('records an alert that nobody opted in to, so it is not tried every minute', async () => {
		const w = world({ recipients: [{ email: 'owner@example.test', userId: 'u1', prefs: {} }] });
		await w.sink().notify(notice(['allowance-75']));
		expect(w.sent).toEqual([]);
		expect(w.claims.size).toBe(1);
	});

	it('names the site for a site alert and the organisation for an organisation alert', async () => {
		const w = world();
		await w.sink().notify(notice(['budget-90'], { siteId: 'site-1' }));
		expect(renderMail(w.sent[0]!.input).subject).toContain('Main site');
		const org = world();
		await org.sink().notify(notice(['budget-90']));
		expect(renderMail(org.sent[0]!.input).subject).toContain('Acme');
	});
});

describe('soft budgets and shadow mode', () => {
	it('says nothing is blocked in a soft budget alert', async () => {
		const w = world();
		await w.sink().notify(
			notice(['allowance-100', 'budget-90'], {
				budget: { percent: 500, enforcement: 'alert' }
			})
		);
		for (const s of w.sent) {
			expect(s.input.soft).toBe(true);
			expect(renderMail(s.input).text).toContain('nothing is blocked');
		}
	});

	it('never sends a block notice for a soft budget', async () => {
		const w = world();
		await w
			.sink()
			.notify(notice(['blocked'], { budget: { percent: 500, enforcement: 'alert' } }));
		expect(w.sent).toEqual([]);
		expect(w.claims.size).toBe(0);
	});

	it('sends the alerts in shadow mode but holds the block notice back and logs it', async () => {
		const w = world();
		await w.sink().notify(notice(['budget-90', 'blocked'], { mode: 'shadow' }));
		expect(new Set(w.sent.map((s) => s.input.alert))).toEqual(new Set(['budget-90']));
		expect(w.logs).toContain('budget block notice held back in shadow mode');
		// when the flag turns on, the block notice is still unsent
		expect(await w.sink().sent(ORG, null, PERIOD)).toEqual([
			{ key: 'budget-90', period: PERIOD }
		]);
	});
});

describe('the unsubscribe secret', () => {
	it('sends essential alerts and holds optional ones while no secret exists', async () => {
		const w = world({ secret: false });
		await w.sink().notify(notice(['allowance-75', 'budget-90']));
		expect(w.sent.map((s) => s.input.alert)).toEqual(['budget-90', 'budget-90']);
		expect(w.logs.filter((m) => m === 'held: no unsubscribe secret')).toHaveLength(1);
		// the held alert is unclaimed, so it can still send later
		expect(await w.sink().sent(ORG, null, PERIOD)).toEqual([
			{ key: 'budget-90', period: PERIOD }
		]);
	});

	it('releases a held alert once a secret exists, and sends it once', async () => {
		const w = world({ secret: false });
		await w.sink().notify(notice(['allowance-75']));
		expect(w.sent).toEqual([]);
		await w.sink(true).notify(notice(['allowance-75']));
		const released = w.sent.length;
		expect(released).toBeGreaterThan(0);
		expect(w.sent.every((s) => s.input.unsubscribeUrl !== undefined)).toBe(true);
		await w.sink(true).notify(notice(['allowance-75']));
		expect(w.sent).toHaveLength(released);
	});
});

describe('the send log', () => {
	it('counts each delivered mail once, by category', async () => {
		const w = world();
		await w.sink().notify(notice(['budget-90', 'allowance-75']));
		expect(w.counted.sort()).toEqual(w.sent.map((s) => s.category).sort());
		expect(w.counted).toHaveLength(w.sent.length);
	});

	it('counts nothing for a mail that did not go out', async () => {
		const w = world({ failMail: true });
		await w.sink().notify(notice(['budget-90']));
		expect(w.counted).toEqual([]);
	});
});

describe('the notification switch and the send log', () => {
	it('holds optional mail while the platform switch is on and still sends essential mail', async () => {
		const w = world({ paused: true });
		await w.sink().notify(notice(['allowance-75', 'budget-90']));
		expect(new Set(w.sent.map((s) => s.category))).toEqual(new Set(['budget-limit']));
		expect(w.recorded).toContain('billing-info:skipped-paused');
		expect(w.recorded.some((entry) => entry.endsWith(':skipped-preference'))).toBe(false);
	});

	it('logs a recipient who has not opted in as skipped, without naming them', async () => {
		const w = world();
		await w.sink().notify(notice(['allowance-75']));
		expect(w.recorded).toEqual(['billing-info:skipped-preference']);
	});

	it('logs a mail that failed to send as failed', async () => {
		const w = world({ failMail: true });
		await w.sink().notify(notice(['budget-90']));
		expect(
			w.recorded.filter((entry) => entry === 'budget-limit:failed').length
		).toBeGreaterThan(0);
	});
});

describe('the daily send budget', () => {
	it('keeps essential mail ahead of optional mail when the budget is short', async () => {
		const w = world({ remaining: 2 });
		await w.sink().notify(notice(['allowance-75', 'budget-90']));
		expect(w.sent.map((s) => s.input.alert)).toEqual(['budget-90', 'budget-90']);
		// the optional alert waits for the next run, unclaimed
		expect(await w.sink().sent(ORG, null, PERIOD)).toEqual([
			{ key: 'budget-90', period: PERIOD }
		]);
	});
});

describe('the block notice on the real path', () => {
	// one site whose hard cap is crossed: 5000 views against a 1000-view allowance at 500 percent
	const org = (enforcement: 'block' | 'alert') => ({
		orgId: ORG,
		allowanceViews: 1000,
		budget: null,
		sites: [{ siteId: 's1', allowanceViews: 1000, budget: { percent: 500, enforcement } }]
	});
	const deps = (
		w: ReturnType<typeof world>,
		mode: 'shadow' | 'on',
		ledger: Map<string, StateRecord>,
		logs: string[]
	): BudgetEnforcementDeps => ({
		alerts: w.sink(),
		mode,
		now: () => Date.UTC(2026, 10, 21),
		source: { organizations: async () => [], organization: async () => null },
		counts: { monthViews: async () => 5000 },
		authority: { applyBudgetState: async () => ({ outcome: 'written', generation: 2 }) },
		ledger: {
			get: async (siteId) => ledger.get(siteId) ?? null,
			set: async (siteId, record) => {
				ledger.set(siteId, record);
			}
		},
		audit: async () => undefined,
		log: (message) => logs.push(message)
	});
	const alertsSent = (w: ReturnType<typeof world>) => w.sent.map((s) => s.input.alert);

	it('holds the block notice back in shadow, sends the other alerts, and logs what would be blocked', async () => {
		const w = world();
		const logs: string[] = [];
		await evaluateOrganization(deps(w, 'shadow', new Map(), logs), org('block'));
		expect(alertsSent(w)).toContain('budget-90');
		expect(alertsSent(w)).not.toContain('blocked');
		expect(logs).toContain('budget enforcement would block');
		expect(w.logs).toContain('budget block notice held back in shadow mode');
	});

	it('sends the block notice once after the flag turns on, while the cap is still crossed', async () => {
		const w = world();
		const ledger = new Map<string, StateRecord>();
		await evaluateOrganization(deps(w, 'shadow', ledger, []), org('block'));
		expect(alertsSent(w)).not.toContain('blocked');
		await evaluateOrganization(deps(w, 'on', ledger, []), org('block'));
		const first = alertsSent(w).filter((alert) => alert === 'blocked').length;
		expect(first).toBeGreaterThan(0);
		await evaluateOrganization(deps(w, 'on', ledger, []), org('block'));
		expect(alertsSent(w).filter((alert) => alert === 'blocked')).toHaveLength(first);
	});

	it('never sends a block notice for a soft budget, in shadow or on', async () => {
		for (const mode of ['shadow', 'on'] as const) {
			const w = world();
			await evaluateOrganization(deps(w, mode, new Map(), []), org('alert'));
			expect(w.sent.length, mode).toBeGreaterThan(0);
			expect(alertsSent(w), mode).not.toContain('blocked');
		}
	});
});

describe('the evaluation feeds the sink', () => {
	it('mails a newly crossed alert once across two evaluations', async () => {
		const w = world();
		const sink = w.sink();
		const deps = {
			alerts: sink,
			mode: 'shadow',
			now: () => Date.UTC(2026, 10, 21),
			source: { organizations: async () => [], organization: async () => null },
			counts: { monthViews: async () => 800 },
			authority: { applyBudgetState: async () => ({ outcome: 'unchanged', generation: 1 }) },
			ledger: { get: async () => null, set: async () => undefined },
			audit: async () => undefined,
			log: () => undefined
		} satisfies BudgetEnforcementDeps;
		const org = {
			orgId: ORG,
			allowanceViews: 1000,
			budget: { percent: 500, enforcement: 'block' as const },
			sites: [{ siteId: 's1', allowanceViews: 1000, budget: null }]
		};
		await evaluateOrganization(deps, org);
		const first = w.sent.length;
		expect(first).toBeGreaterThan(0);
		await evaluateOrganization(deps, org);
		expect(w.sent).toHaveLength(first);
	});

	it('never lets a failing alert stop the evaluation', async () => {
		const logs: string[] = [];
		const deps = {
			alerts: {
				sent: async () => [],
				notify: async () => {
					throw new Error('boom');
				}
			},
			mode: 'on',
			now: () => Date.UTC(2026, 10, 21),
			source: { organizations: async () => [], organization: async () => null },
			counts: { monthViews: async () => 800 },
			authority: { applyBudgetState: async () => ({ outcome: 'unchanged', generation: 1 }) },
			ledger: { get: async () => null, set: async () => undefined },
			audit: async () => undefined,
			log: (message: string) => logs.push(message)
		} satisfies BudgetEnforcementDeps;
		const result = await evaluateOrganization(deps, {
			orgId: ORG,
			allowanceViews: 1000,
			budget: { percent: 500, enforcement: 'block' },
			sites: [{ siteId: 's1', allowanceViews: 1000, budget: null }]
		});
		expect(result.sites).toHaveLength(1);
		expect(logs).toContain('budget alert failed');
	});
});
