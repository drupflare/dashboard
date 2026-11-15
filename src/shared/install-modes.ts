export type InstallAvailability = { state: 'available' } | { state: 'unavailable'; reason: string };

export type InstallMode = {
	id: 'full-tree' | 'full-module' | 'patch' | 'temp';
	label: string;
	summary: string;
	availability: InstallAvailability;
};

export const INSTALL_MODES: readonly InstallMode[] = [
	{
		id: 'full-tree',
		label: 'Whole Site',
		summary: 'Build the whole codebase, with its dependencies, into a new site.',
		availability: {
			state: 'unavailable',
			reason: 'Building a whole site from code is not running yet.'
		}
	},
	{
		id: 'full-module',
		label: 'One Module',
		summary: 'Add one module from a connected repository to a site.',
		availability: { state: 'available' }
	},
	{
		id: 'patch',
		label: 'Change a Module',
		summary: 'Apply a change to a module that a site already runs.',
		availability: {
			state: 'unavailable',
			reason: 'Changing a module on a live site is not available yet.'
		}
	},
	{
		id: 'temp',
		label: 'Temporary Copy',
		summary: 'Run the code on a copy of the site that goes away when you are done with it.',
		availability: { state: 'unavailable', reason: 'Temporary copies are not available yet.' }
	}
];
