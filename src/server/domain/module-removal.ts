import { machineName, type ModuleManifest } from '../../shared/modules';

export interface RemovalInput {
	// the composer name, vendor/project
	name: string;
	// project names of the modules enabled on the site
	enabledModules: readonly string[];
	// project names of the modules that need this one, enabled or not; null when the site was not asked
	dependents: readonly string[] | null;
	census: ModuleManifest;
	// what removing the module would delete, when the caller has it
	wouldDelete?: readonly string[];
}

// the site takes the module out of Drupal first; the files go only after that worked
export const REMOVAL_ORDER = ['uninstall', 'remove-files'] as const;

export type RemovalVerdict =
	| { ok: false; reason: string; blockedBy: string[] }
	| {
			ok: true;
			order: typeof REMOVAL_ORDER;
			orderNote: string;
			wouldDelete: string[];
	  };

const refuse = (reason: string, blockedBy: string[] = []): RemovalVerdict => ({
	ok: false,
	reason,
	blockedBy
});

function listOf(names: readonly string[]): string {
	if (names.length < 3) return names.join(' and ');
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function guardRemoval(input: RemovalInput): RemovalVerdict {
	const row = input.census.modules.find((candidate) => candidate.name === input.name);
	if (row === undefined) return refuse('That module is not on the list.');
	if (row.shipping) {
		return refuse(`${row.label} is included with every site and cannot be removed.`);
	}
	const project = machineName(input.name);
	if (!input.enabledModules.includes(project)) {
		return refuse(`${row.label} is not enabled on this site, so there is nothing to remove.`);
	}
	const blockedBy = (input.dependents ?? []).filter((dependent) =>
		input.enabledModules.includes(dependent)
	);
	if (blockedBy.length > 0) {
		const many = blockedBy.length > 1;
		return refuse(
			`${row.label} is needed by ${listOf(blockedBy)}, which ${many ? 'are' : 'is'} enabled. Turn ${many ? 'them' : 'it'} off first.`,
			blockedBy
		);
	}
	return {
		ok: true,
		order: REMOVAL_ORDER,
		orderNote: `The site uninstalls ${row.label} first. Its files are removed only after that succeeds.`,
		wouldDelete: [...(input.wouldDelete ?? [])]
	};
}
