import { z } from 'zod';
import type { OptionalCategory } from './notifications';

export interface SwitchInfo {
	category: OptionalCategory;
	label: string;
	description: string;
	// false while nothing sends under the category; the switch is shown and stores nothing
	available: boolean;
}

export const SWITCHES: readonly SwitchInfo[] = [
	{
		category: 'ops',
		label: 'Operations Updates',
		description:
			'Findings on your sites, results of upgrades, restores and repairs, and access reviews that open on their schedule. One email for each event. Owners and admins get the access review emails.',
		available: true
	},
	{
		category: 'billing-info',
		label: 'Billing Information',
		description:
			'Invoice copies and usage notices, including a note when a site passes 75, 90, 100 or 250 percent of its monthly view allowance. At most one email for each level a month. Owners and billing members get these.',
		available: true
	},
	{
		category: 'reports',
		label: 'Reports',
		description:
			'Client and site reports by email. No report email exists yet, so this switch has no effect for now.',
		available: true
	},
	{
		category: 'digest',
		label: 'Daily Summary',
		description: 'Send me a daily summary instead of one email per event. Not available yet.',
		available: false
	}
];

export interface EssentialInfo {
	label: string;
	description: string;
}

export const ESSENTIAL_NOTICES: readonly EssentialInfo[] = [
	{
		label: 'Sign-In and Recovery Codes',
		description: 'You need these to get into your account.'
	},
	{ label: 'Invitations', description: 'The person invited needs the email to join.' },
	{
		label: 'Security Events',
		description: 'A new sign-in method or a change to your credentials always reaches you.'
	},
	{ label: 'Failed Payments', description: 'These keep your account in good standing.' },
	{
		label: 'Stop Alerts: When a Site Reaches Its Budget',
		description:
			'A site at a hard budget stops serving visitors, and the 90 percent warning comes first. Neither can wait for a preference.'
	},
	{
		label: 'Changes to Your Agreement',
		description: 'Price and terms changes must reach you directly.'
	}
];

export interface SwitchView extends SwitchInfo {
	enabled: boolean;
}

export interface PreferencesView {
	switches: SwitchView[];
	essential: EssentialInfo[];
}

// keys are checked in the service so an essential or unknown name gets a plain message
export const preferencesBodySchema = z.object({
	preferences: z.record(z.string().max(40), z.boolean()).refine((value) => {
		const count = Object.keys(value).length;
		return count > 0 && count <= 8;
	}, 'Name at least one preference')
});

export type PreferencesBody = z.infer<typeof preferencesBodySchema>;

export const unsubscribeQuerySchema = z.object({ token: z.string().min(20).max(600) });

export const unsubscribeResultSchema = z.object({
	unsubscribed: z.literal(true),
	category: z.enum(['ops', 'billing-info', 'reports', 'digest'])
});

export type UnsubscribeResult = z.infer<typeof unsubscribeResultSchema>;

export const preferencesResponse = z.object({
	switches: z.array(
		z.object({
			category: z.enum(['ops', 'billing-info', 'reports', 'digest']),
			label: z.string(),
			description: z.string(),
			available: z.boolean(),
			enabled: z.boolean()
		})
	),
	essential: z.array(z.object({ label: z.string(), description: z.string() }))
});
