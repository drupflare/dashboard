import type { CollegeDBClient } from '@earth-app/collegedb';
import { recipeSchema, type Recipe } from '../../../shared/recipes';

export interface CustomRelease {
	id: string;
	organizationId: string;
	sha256: string;
	fileName: string;
	bundleKey: string;
	recipe: Recipe;
	createdAt: number;
}

interface Row {
	id: string;
	organization_id: string;
	sha256: string;
	file_name: string;
	bundle_key: string;
	recipe: string;
	created_at: number;
}

const COLUMNS = 'id, organization_id, sha256, file_name, bundle_key, recipe, created_at';

const toRelease = (row: Row): CustomRelease => ({
	id: row.id,
	organizationId: row.organization_id,
	sha256: row.sha256,
	fileName: row.file_name,
	bundleKey: row.bundle_key,
	recipe: recipeSchema.parse(JSON.parse(row.recipe)),
	createdAt: row.created_at
});

// the organisation is in the key, so another organisation's id answers null
export async function getCustomRelease(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<CustomRelease | null> {
	const { results } = await db.all<Row>(
		organizationId,
		`SELECT ${COLUMNS} FROM custom_releases WHERE organization_id = ? AND id = ?`,
		[organizationId, id]
	);
	const row = results[0];
	return row === undefined ? null : toRelease(row);
}

// the same archive twice is one release, and the first file name stays
export async function registerCustomRelease(
	db: CollegeDBClient,
	release: Omit<CustomRelease, 'createdAt'> & { now: number }
): Promise<CustomRelease> {
	await db.run(
		release.organizationId,
		`INSERT OR IGNORE INTO custom_releases (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			release.id,
			release.organizationId,
			release.sha256,
			release.fileName,
			release.bundleKey,
			JSON.stringify(release.recipe),
			release.now
		]
	);
	const stored = await getCustomRelease(db, release.organizationId, release.id);
	if (stored === null) throw new Error('the custom release is missing after the insert');
	return stored;
}

// the file name and sha256 prefix of each release id given, for the notes of a history list
export async function customReleaseNotes(
	db: CollegeDBClient,
	organizationId: string,
	ids: readonly string[]
): Promise<Map<string, string>> {
	const notes = new Map<string, string>();
	for (const id of new Set(ids)) {
		const release = await getCustomRelease(db, organizationId, id);
		if (release !== null) notes.set(id, customReleaseNote(release));
	}
	return notes;
}

export const customReleaseNote = (release: Pick<CustomRelease, 'fileName' | 'sha256'>) =>
	`Uploaded ${release.fileName} (${release.sha256.slice(0, 12)})`;
