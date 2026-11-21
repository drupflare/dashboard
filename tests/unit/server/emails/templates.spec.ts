import { describe, expect, it } from 'vitest';
import { renderMail, type MailInput } from '../../../../src/server/emails';
import { unsubscribeToken, verifyUnsubscribe } from '../../../../src/server/services/notifications';

const KEY = 'unsubscribe-test-key';
const NOW = Date.UTC(2026, 0, 1);
const UNSUBSCRIBE_BASE = 'https://app.example.test/unsubscribe?token=';

const essential: MailInput[] = [
	{ kind: 'login-code', purpose: 'sign-in', code: '483920', expiresInMinutes: 10 },
	{ kind: 'login-code', purpose: 'recovery', code: '117733', expiresInMinutes: 10 },
	{ kind: 'login-code', purpose: 'verify-email', code: '551204', expiresInMinutes: 10 },
	{
		kind: 'invitation',
		inviterName: 'Maria Lopez',
		orgName: 'Riverside College',
		acceptUrl: 'https://app.example.test/invite/abc123',
		expiresInDays: 7
	},
	{
		kind: 'security-event',
		summary: 'a new device signed in',
		occurredAt: '2026-01-01T09:00:00Z',
		reviewUrl: 'https://app.example.test/account/activity'
	},
	{
		kind: 'payment-failure',
		planName: 'Team',
		billingUrl: 'https://app.example.test/billing'
	},
	{
		kind: 'mandatory-notice',
		title: 'Price change',
		effectiveDate: '2026-03-01',
		summary: 'The Team plan price changes on that date.',
		termsUrl: 'https://app.example.test/terms'
	}
];

async function unsubscribeFor(category: 'ops' | 'billing-info' | 'digest'): Promise<string> {
	return `${UNSUBSCRIBE_BASE}${await unsubscribeToken('usr_abc12345', category, KEY, NOW)}`;
}

async function optional(): Promise<MailInput[]> {
	return [
		{
			kind: 'ops-finding',
			siteName: 'north-campus',
			severity: 'high',
			finding: 'the cron endpoint returns 500',
			detectedAt: '2026-01-01T08:30:00Z',
			viewUrl: 'https://app.example.test/sites/north-campus/findings/f1',
			unsubscribeUrl: await unsubscribeFor('ops')
		},
		{
			kind: 'usage-warning',
			siteName: 'north-campus',
			percentUsed: 85,
			forecastUrl: 'https://app.example.test/usage',
			unsubscribeUrl: await unsubscribeFor('billing-info')
		},
		{
			kind: 'digest',
			windowLabel: 'Monday to Tuesday',
			lines: ['north-campus: cron endpoint returns 500', 'south-campus: usage at 60 percent'],
			unsubscribeUrl: await unsubscribeFor('digest')
		}
	];
}

// the purpose and kind fields pick wording, so their raw values are not facts the body repeats
function stringValues(input: MailInput): string[] {
	return Object.entries(input)
		.filter(([key]) => key !== 'kind' && key !== 'purpose')
		.map(([, value]) => value)
		.filter((value): value is string => typeof value === 'string');
}

describe('renderMail', () => {
	it('fills every placeholder and leaves no undefined, null or NaN', async () => {
		for (const input of [...essential, ...(await optional())]) {
			const mail = renderMail(input);
			for (const body of [mail.subject, mail.text, mail.html]) {
				expect(body).not.toMatch(/undefined|null|NaN|\{\{|\$\{/);
			}
		}
	});

	it('writes the text and HTML with the same facts', async () => {
		for (const input of [...essential, ...(await optional())]) {
			const mail = renderMail(input);
			for (const value of stringValues(input)) {
				if (value === input.kind) continue;
				expect(mail.text).toContain(value);
				expect(mail.html).toContain(value);
			}
		}
	});

	it('escapes user-supplied text in the HTML body', () => {
		const mail = renderMail({
			kind: 'invitation',
			inviterName: 'Maria',
			orgName: '<b>Riverside</b>',
			acceptUrl: 'https://app.example.test/invite/abc123',
			expiresInDays: 7
		});
		expect(mail.html).not.toContain('<b>Riverside</b>');
		expect(mail.html).toContain('&lt;b&gt;Riverside&lt;/b&gt;');
		expect(mail.text).toContain('<b>Riverside</b>');
	});

	it('maps each kind to its category', async () => {
		expect(renderMail(essential[0]!).category).toBe('login-code');
		expect(renderMail(essential[3]!).category).toBe('invitation');
		expect(renderMail(essential[6]!).category).toBe('mandatory-notice');
		const [ops, usage, digest] = await optional();
		expect(renderMail(ops!).category).toBe('ops');
		expect(renderMail(usage!).category).toBe('billing-info');
		expect(renderMail(digest!).category).toBe('digest');
	});

	it('gives essential mail no unsubscribe link, list headers or promotional wording', () => {
		for (const input of essential) {
			const mail = renderMail(input);
			for (const body of [mail.text, mail.html]) {
				expect(body.toLowerCase()).not.toContain('unsubscribe');
				expect(body).not.toMatch(
					/\b(sale|discount|special offer|limited time|upgrade today)\b/i
				);
			}
			expect(mail.headers).toEqual({});
		}
	});

	it('gives every optional message a working signed unsubscribe link and list headers', async () => {
		for (const input of await optional()) {
			const mail = renderMail(input);
			const link = /token=([A-Za-z0-9_.-]+)/.exec(mail.text);
			expect(link).not.toBeNull();
			expect(mail.html).toContain(`token=${link![1]}`);
			const verified = await verifyUnsubscribe(link![1]!, KEY, NOW);
			expect(verified.category).toBe(mail.category);
			expect(mail.headers['List-Unsubscribe']).toBe(`<${UNSUBSCRIBE_BASE}${link![1]}>`);
			expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
		}
	});

	it('keeps copy plain: no em dashes, no AI vocabulary', async () => {
		const banned =
			/\b(delve|robust|comprehensive|seamless|leverag\w*|crucial|showcase|holistic|game-changer|furthermore|moreover)\b/i;
		for (const input of [...essential, ...(await optional())]) {
			const mail = renderMail(input);
			for (const body of [mail.subject, mail.text, mail.html]) {
				expect(body).not.toContain('—');
				expect(body).not.toMatch(banned);
			}
		}
	});
});

describe('security-event mail', () => {
	it('links the review button to the page the event names, not a fixed page', () => {
		const site = renderMail({
			kind: 'security-event',
			summary: 'the site was suspended',
			occurredAt: '2026-01-01T09:00:00Z',
			reviewUrl: 'https://app.example.test/sites/site_1'
		});
		expect(site.html).toContain('https://app.example.test/sites/site_1');
		expect(site.html).not.toContain('/org/sso');
		expect(site.text).not.toContain('/org/sso');
	});
});

describe('budget mail', () => {
	const KEYS = [
		'allowance-75',
		'allowance-90',
		'allowance-100',
		'allowance-250',
		'budget-90',
		'blocked'
	] as const;
	const all = (): Extract<MailInput, { kind: 'budget-alert' }>[] =>
		KEYS.flatMap((alert) =>
			[true, false].flatMap((soft) =>
				[null, 'Main site'].flatMap((siteName) =>
					[1_234_567, null].map((views) => ({
						kind: 'budget-alert' as const,
						alert,
						orgName: 'Riverside College',
						siteName,
						views,
						allowanceViews: 1_000_000,
						budgetPercent: 500,
						soft,
						budgetUrl: 'https://app.example.test/billing',
						...(alert === 'blocked' || alert === 'budget-90'
							? {}
							: { unsubscribeUrl: `${UNSUBSCRIBE_BASE}x` })
					}))
				)
			)
		);

	it('has no em dash, no price and never says instantly', () => {
		for (const input of all()) {
			const mail = renderMail(input);
			for (const body of [mail.subject, mail.text, mail.html]) {
				expect(body).not.toContain('—');
				expect(body).not.toMatch(/\$|dollar|price|\binstant/i);
				expect(body).not.toMatch(/\b(white-glove|seamless|robust|leverag\w*)\b/i);
			}
		}
	});

	it('puts the block notice and the 90 percent notice in the essential class', () => {
		for (const input of all()) {
			const mail = renderMail(input);
			const essentialAlert = input.alert === 'blocked' || input.alert === 'budget-90';
			expect(mail.category).toBe(essentialAlert ? 'budget-limit' : 'billing-info');
			expect('List-Unsubscribe' in mail.headers).toBe(!essentialAlert);
		}
	});

	it('says what happened, the numbers, what it means for visitors and where to change it', () => {
		const hard = renderMail({
			...all()[0]!,
			alert: 'budget-90',
			soft: false,
			views: 4_600_000
		});
		expect(hard.text).toContain('90 percent of its spend budget');
		expect(hard.text).toContain('4,600,000');
		expect(hard.text).toContain('visitors stop being served');
		expect(hard.text).toContain('Change the budget: https://app.example.test/billing');
		const soft = renderMail({ ...all()[0]!, alert: 'budget-90', soft: true });
		expect(soft.text).toContain('nothing is blocked');
		expect(soft.text).not.toContain('stop being served');
		const stop = renderMail({ ...all()[0]!, alert: 'blocked', soft: false });
		expect(stop.text).toContain('no longer being served');
	});
});
