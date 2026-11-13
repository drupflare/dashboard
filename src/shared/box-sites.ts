export const BOX_SITE_REMOVE_STEP = 'remove';

export const FOUND_BADGE = 'Found on Your Box';

export const MISSING_BADGE = 'Not on the Box';

export const FOUND_NOTE =
	'Your box reported this site, so the dashboard added it to your list. Nothing was changed on the box.';

export const FOUND_NAME_NOTE =
	'The box did not share the site address, so this name is a placeholder. Rename the site to something you will recognize.';

export const MISSING_NOTE =
	'This site is not on the box right now. Check that the box is running and still has the site, or remove it from your list.';

export const BOX_SITE_ELSEWHERE =
	'This site runs on your box. Remove it from the box first, then it can be removed here.';

export const CHECK_BOX_LABEL = 'Check the Box';

export const RENAME_LABEL = 'Rename Site';

export type BoxDeleteCase = 'found' | 'gone' | 'present';

// where a site on a box stands for a delete: found by the box, made here and no longer on the box,
// or made here and still there
export function boxDeleteCase(box: { found: boolean; missingSince: string | null }): BoxDeleteCase {
	if (box.found) return 'found';
	return box.missingSince === null ? 'present' : 'gone';
}

// what the delete dialog says for a site on a box, where the delete takes the row and never the site
export function boxDeleteNote(state: BoxDeleteCase): string[] {
	if (state === 'found') {
		return [
			'This removes the site from your list only. The site stays on your box and keeps serving.',
			'The dashboard does not add it back. There is no undo in the dashboard.'
		];
	}
	if (state === 'gone') {
		return [
			'This removes the site from your list only. The box no longer has it.',
			'There is no undo in the dashboard.'
		];
	}
	return [BOX_SITE_ELSEWHERE];
}

const stamp = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

export function missingSinceNote(missingSince: string): string {
	return `Not seen on the box since ${stamp.format(new Date(missingSince))}.`;
}
