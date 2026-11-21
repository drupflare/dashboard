import type { AlertKey } from '../../shared/budget-rules';
import type { NotificationCategory } from '../../shared/notifications';
import { listHeaders } from '../services/notifications';

export type MailInput =
	| {
			kind: 'login-code';
			purpose: 'sign-in' | 'recovery' | 'verify-email';
			code: string;
			expiresInMinutes: number;
	  }
	| {
			kind: 'invitation';
			inviterName: string;
			orgName: string;
			acceptUrl: string;
			expiresInDays: number;
	  }
	| { kind: 'security-event'; summary: string; occurredAt: string; reviewUrl: string }
	| { kind: 'payment-failure'; planName: string; billingUrl: string }
	| {
			kind: 'mandatory-notice';
			title: string;
			effectiveDate: string;
			summary: string;
			termsUrl: string;
	  }
	| {
			kind: 'ops-finding';
			siteName: string;
			severity: string;
			finding: string;
			detectedAt: string;
			viewUrl: string;
			unsubscribeUrl: string;
	  }
	| {
			kind: 'usage-warning';
			siteName: string;
			percentUsed: number;
			forecastUrl: string;
			unsubscribeUrl: string;
	  }
	| {
			kind: 'budget-alert';
			alert: AlertKey;
			orgName: string;
			// null: the alert is about the whole organisation
			siteName: string | null;
			views: number | null;
			allowanceViews: number | null;
			budgetPercent: number;
			soft: boolean;
			budgetUrl: string;
			// present on the optional classes only
			unsubscribeUrl?: string;
	  }
	| {
			kind: 'access-review';
			orgName: string;
			scopeName: string;
			dueDate: string;
			reviewUrl: string;
			unsubscribeUrl: string;
	  }
	| { kind: 'digest'; windowLabel: string; lines: string[]; unsubscribeUrl: string }
	| {
			kind: 'contact-verify';
			orgName: string;
			role: string;
			confirmUrl: string;
			expiresInDays: number;
	  }
	| { kind: 'test-notice'; orgName: string; role: string; sentAt: string; settingsUrl: string };

export interface RenderedMail {
	category: NotificationCategory;
	subject: string;
	text: string;
	html: string;
	headers: Record<string, string>;
}

interface Link {
	label: string;
	url: string;
}

interface Content {
	category: NotificationCategory;
	subject: string;
	paragraphs: string[];
	links: Link[];
}

// #region templates

const LOGIN_LEAD = {
	'sign-in': 'Use this code to sign in to Drupflare:',
	recovery: 'Use this code to recover your Drupflare account:',
	'verify-email': 'Use this code to confirm your email address:'
};

const LOGIN_SUBJECT = {
	'sign-in': 'Your Drupflare sign-in code',
	recovery: 'Your Drupflare recovery code',
	'verify-email': 'Confirm your Drupflare email address'
};

const count = (value: number) => value.toLocaleString('en-US');

// the block notice and the 90 percent of budget notice are essential; allowance alerts are optional
export function budgetAlertCategory(alert: AlertKey): NotificationCategory {
	return alert === 'blocked' || alert === 'budget-90' ? 'budget-limit' : 'billing-info';
}

function budgetContent(input: Extract<MailInput, { kind: 'budget-alert' }>): Content {
	const who = input.siteName ?? input.orgName;
	const percent = `${input.budgetPercent} percent`;
	const cap =
		input.allowanceViews === null
			? null
			: Math.ceil((input.allowanceViews * Math.round(input.budgetPercent * 10)) / 1000);
	const used =
		input.views === null
			? []
			: [
					`We have counted at least ${count(input.views)} views this month${
						input.allowanceViews === null
							? '.'
							: `, against a monthly allowance of ${count(input.allowanceViews)} views.`
					}`
				];
	let subject: string;
	let lead: string;
	if (input.alert === 'blocked') {
		subject = `${who} reached its spend budget`;
		lead = `${who} on ${input.orgName} reached its spend budget of ${percent} of the monthly view allowance.`;
	} else if (input.alert === 'budget-90') {
		subject = `${who} is at 90 percent of its spend budget`;
		lead = `${who} on ${input.orgName} has used 90 percent of its spend budget, which is ${percent} of the monthly view allowance.`;
	} else {
		const level = input.alert.slice('allowance-'.length);
		subject = `${who} has used ${level} percent of its monthly views`;
		lead = `${who} on ${input.orgName} has used ${level} percent of its monthly view allowance.`;
	}
	let meaning: string;
	if (input.soft) {
		meaning =
			'Your budget is soft, so nothing is blocked. Visitors keep reaching the site whatever the count.';
	} else if (input.alert === 'blocked') {
		meaning =
			'Visitors are no longer being served. A higher budget lifts the stop the next time the site renews its lease.';
	} else {
		meaning = `When the site reaches the budget${
			cap === null ? '' : `, about ${count(cap)} views`
		}, visitors stop being served until you raise the budget or the month ends.`;
	}
	return {
		category: budgetAlertCategory(input.alert),
		subject,
		paragraphs: [lead, ...used, meaning],
		links: [{ label: 'Change the budget', url: input.budgetUrl }]
	};
}

function contentFor(input: MailInput): Content {
	switch (input.kind) {
		case 'budget-alert':
			return budgetContent(input);
		case 'login-code':
			return {
				category: 'login-code',
				subject: LOGIN_SUBJECT[input.purpose],
				paragraphs: [
					LOGIN_LEAD[input.purpose],
					input.code,
					`The code expires in ${input.expiresInMinutes} minutes. If you didn't ask for it, you can ignore this email.`
				],
				links: []
			};
		case 'invitation':
			return {
				category: 'invitation',
				subject: `${input.inviterName} invited you to ${input.orgName}`,
				paragraphs: [
					`${input.inviterName} invited you to join ${input.orgName} on Drupflare.`,
					`The invitation expires in ${input.expiresInDays} days. If you weren't expecting it, you can ignore this email.`
				],
				links: [{ label: 'Accept the invitation', url: input.acceptUrl }]
			};
		case 'security-event':
			return {
				category: 'security-event',
				subject: 'Security alert for your Drupflare account',
				paragraphs: [
					`We noticed a security event on your account: ${input.summary}.`,
					`It happened at ${input.occurredAt}.`,
					"If this was you, you don't need to do anything. If it wasn't, review your account activity and remove any sign-in method you don't recognize."
				],
				links: [{ label: 'Review account activity', url: input.reviewUrl }]
			};
		case 'payment-failure':
			return {
				category: 'payment-failure',
				subject: "We couldn't process your Drupflare payment",
				paragraphs: [
					`We couldn't process the latest payment for your ${input.planName} plan.`,
					'Update your payment details to avoid a change to your plan.'
				],
				links: [{ label: 'Update payment details', url: input.billingUrl }]
			};
		case 'mandatory-notice':
			return {
				category: 'mandatory-notice',
				subject: `Important notice: ${input.title}`,
				paragraphs: [
					`${input.title}, effective ${input.effectiveDate}.`,
					input.summary,
					'We send this notice by email so the change reaches you directly. You can also read it in your dashboard.'
				],
				links: [{ label: 'Read the full notice', url: input.termsUrl }]
			};
		case 'ops-finding':
			return {
				category: 'ops',
				subject: `Finding on ${input.siteName}: ${input.severity} severity`,
				paragraphs: [
					`We found an issue on ${input.siteName}: ${input.finding}.`,
					`Detected at ${input.detectedAt}. Severity: ${input.severity}.`
				],
				links: [{ label: 'View the finding', url: input.viewUrl }]
			};
		case 'usage-warning':
			return {
				category: 'billing-info',
				subject: `${input.siteName} has used ${input.percentUsed}% of its views`,
				paragraphs: [
					`${input.siteName} has used ${input.percentUsed}% of its view allowance for this period.`,
					'Check the usage forecast to see whether it will reach the limit.'
				],
				links: [{ label: 'Open the usage forecast', url: input.forecastUrl }]
			};
		case 'contact-verify':
			return {
				category: 'security-event',
				subject: `Confirm your ${input.role} contact for ${input.orgName}`,
				paragraphs: [
					`Someone listed this address as the ${input.role} contact for ${input.orgName} on Drupflare.`,
					`The link expires in ${input.expiresInDays} days. If you don't know this organisation, ignore this email.`
				],
				links: [{ label: 'Confirm this address', url: input.confirmUrl }]
			};
		case 'test-notice':
			return {
				category: 'ops',
				subject: `Test notification for ${input.orgName}`,
				paragraphs: [
					`This is a test from ${input.orgName} on Drupflare, sent to the ${input.role} contact at ${input.sentAt}.`,
					'No action is needed.'
				],
				links: [{ label: 'Open the contacts page', url: input.settingsUrl }]
			};
		case 'access-review':
			return {
				category: 'ops',
				subject: `An access review is ready for ${input.orgName}`,
				paragraphs: [
					`A new access review is open for ${input.orgName}. It covers ${input.scopeName.toLowerCase()}.`,
					`Decide each item by ${input.dueDate}: keep it, or remove it. Nobody can decide an item about themselves.`
				],
				links: [{ label: 'Open the review', url: input.reviewUrl }]
			};
		case 'digest':
			return {
				category: 'digest',
				subject: `Drupflare digest for ${input.windowLabel}`,
				paragraphs: [`Here is your digest for ${input.windowLabel}.`, ...input.lines],
				links: []
			};
	}
}

// #endregion

// #region render

function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

export function renderMail(input: MailInput): RenderedMail {
	const content = contentFor(input);
	const paragraphs = [...content.paragraphs];
	const links = [...content.links];
	const unsubscribeUrl = 'unsubscribeUrl' in input ? input.unsubscribeUrl : undefined;
	if (unsubscribeUrl !== undefined) {
		paragraphs.push(
			'You get these emails because you turned them on in your notification settings.'
		);
		links.push({ label: 'Stop these emails', url: unsubscribeUrl });
	}

	const text = [
		paragraphs.join('\n\n'),
		...links.map((link) => `${link.label}: ${link.url}`)
	].join('\n\n');
	const html = [
		'<!doctype html><html><body style="font-family:Lato,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1d1b20">',
		...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
		...links.map(
			(link) => `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`
		),
		'</body></html>'
	].join('');

	return {
		category: content.category,
		subject: content.subject,
		text,
		html,
		headers: unsubscribeUrl === undefined ? {} : listHeaders(content.category, unsubscribeUrl)
	};
}

// #endregion
