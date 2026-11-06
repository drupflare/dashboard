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
	| { kind: 'digest'; windowLabel: string; lines: string[]; unsubscribeUrl: string };

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

function contentFor(input: MailInput): Content {
	switch (input.kind) {
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
