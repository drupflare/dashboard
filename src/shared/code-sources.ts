export type CodeSource = {
	id: 'files' | 'repository' | 'worker' | 'git-url';
	label: string;
	summary: string;
	// a route in this app; null when it cannot be done yet
	href: string | null;
	reason?: string;
};

export const CODE_SOURCES: readonly CodeSource[] = [
	{
		id: 'files',
		label: 'Upload Files to a Site',
		summary:
			'Add a module, theme or profile from files on your computer. Pick a site, then open Code History.',
		href: '/sites'
	},
	{
		id: 'repository',
		label: 'Attach a Repository',
		summary:
			'Mount any repository your connected account can read, verified or not. It pulls on a schedule.',
		href: '/org/integrations'
	},
	{
		id: 'worker',
		label: 'Upload Your Own Worker',
		summary: 'Deploy a built Worker bundle as a new site.',
		href: '/new/custom'
	},
	{
		id: 'git-url',
		label: 'Use a Public Git Address',
		summary: 'Paste the address of a public repository.',
		href: null,
		reason: 'A repository has to be reachable through a connected account first.'
	}
];

export type CodeUse = { label: string; summary: string; href: string | null; reason?: string };

// what can be done with one corpus entry today; a failing check is a warning and never a refusal
export function usesOf(entry: { shape: string | null; repo: string | null }): CodeUse[] {
	if (entry.shape === 'module' || entry.shape === 'modules' || entry.shape === 'suite') {
		return [
			{
				label: 'Add It to a Site',
				summary:
					'Attach its repository to a site as a module. Connect the repository first.',
				href: '/org/integrations'
			}
		];
	}
	return [
		{
			label: 'Create a Site From It',
			summary: 'Build the whole codebase, with its dependencies, into a new site.',
			href: null,
			reason: 'Building a whole site from a repository is not running yet.'
		},
		{
			label: 'Upload Its Files to a Site',
			summary: 'Download it, then upload the part you need to a site from Code History.',
			href: '/sites'
		}
	];
}
