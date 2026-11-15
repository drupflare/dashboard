export const RESTORE_LAYERS = ['export', 'pitr'] as const;
export type RestoreLayer = (typeof RESTORE_LAYERS)[number];

export const PITR_WINDOW_DAYS = 30;

export interface RestorePoint {
	id: string;
	layer: 'export';
	createdAt: string;
	label: string | null;
	verified: boolean;
	moves: string[];
	doesNotMove: string[];
}

// a layer the platform offers for the site, with no rows of its own in the list
export interface RestoreLayerOffer {
	layer: 'pitr';
	windowDays: number;
	moves: string[];
	doesNotMove: string[];
}

// plain words per layer; sources are worker docs/operating/recovery.md (export and PITR sections)
export const RESTORE_LAYER_FACTS: Record<RestoreLayer, { moves: string[]; doesNotMove: string[] }> =
	{
		export: {
			moves: ['The site database as it stood when the copy was taken'],
			doesNotMove: [
				'Uploaded files held in separate file storage',
				'Sign-in and integration secrets, such as the owner token, the signing salt and git access tokens',
				'Anything changed after the copy was taken'
			]
		},
		pitr: {
			moves: [
				'Everything in the site database and its stored key-value pairs, as it stood at a chosen moment in the last 30 days'
			],
			doesNotMove: [
				'Uploaded files kept in separate file storage',
				'Anything written after the chosen moment',
				'Anything after the site itself is deleted, because its recovery history is kept with the site'
			]
		}
	};
