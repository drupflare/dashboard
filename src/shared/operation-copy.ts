import type { Operation } from '@contracts/operations';

// how long a deleted site's address stays reserved; dispatch/src/registry.ts holds the same number
export const SITE_HOLD_DAYS = 90;

export interface OperationLink {
	to: string;
	label: string;
}

// the words the progress screen uses for one operation type
export interface OperationCopy {
	// the heading, before and after the operation ends
	title: string;
	running: string;
	success: string;
	// the title of the panel shown when the operation fails
	failure: string;
	// shown after success; null when the screen has its own content instead
	link: (operation: Pick<Operation, 'targetIds'>) => OperationLink | null;
	// the button in the failure panel
	failureLink: (operation: Pick<Operation, 'targetIds'>) => OperationLink;
}

const sites: OperationLink = { to: '/sites', label: 'Back to Sites' };

// every operation of these types names its site first
function siteOf(operation: Pick<Operation, 'targetIds'>): OperationLink {
	const id = operation.targetIds[0];
	return id === undefined
		? sites
		: { to: `/sites/${encodeURIComponent(id)}`, label: 'Back to the Site' };
}

export const OPERATION_COPY = {
	'site.create': {
		title: 'Creating Your Site',
		running: 'Your site is being created.',
		success: 'Your site is ready.',
		failure: 'Could Not Create the Site',
		link: () => null,
		failureLink: () => ({ to: '/new', label: 'Try Again' })
	},
	'site.delete': {
		title: 'Deleting Your Site',
		running: 'Your site is being deleted. It stops serving once access is revoked.',
		success: `Site deleted. Its address is held for ${SITE_HOLD_DAYS} days, and its backups are kept.`,
		failure: 'Could Not Delete the Site',
		link: () => sites,
		failureLink: siteOf
	},
	'site.upgrade': {
		title: 'Updating Your Site',
		running: 'Your site is being updated to the new release.',
		success: 'Your site is up to date.',
		failure: 'Could Not Update the Site',
		link: siteOf,
		failureLink: siteOf
	},
	'backup.create': {
		title: 'Backing Up Your Site',
		running: 'Your site is being backed up.',
		success: 'The backup is saved.',
		failure: 'Could Not Back Up the Site',
		link: siteOf,
		failureLink: siteOf
	},
	'backup.restore': {
		title: 'Restoring a Backup',
		running: 'The backup is being restored into the site.',
		success: 'The backup is restored.',
		failure: 'Could Not Restore the Backup',
		link: siteOf,
		failureLink: siteOf
	}
} satisfies Partial<Record<Operation['type'], OperationCopy>>;

const GENERIC: OperationCopy = {
	title: 'Operation Progress',
	running: 'The operation is running.',
	success: 'The operation finished.',
	failure: 'The Operation Failed',
	link: () => sites,
	failureLink: () => sites
};

export function copyFor(type: Operation['type'] | undefined): OperationCopy {
	if (type === undefined) return GENERIC;
	return (OPERATION_COPY as Partial<Record<Operation['type'], OperationCopy>>)[type] ?? GENERIC;
}
