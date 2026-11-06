const UNVERIFIED = 'no static-site repository was read for this recipe';

export const staticSite = {
	id: 'static-site',
	name: 'Static Site',
	category: 'workers',
	compatibility: {
		flags: [],
		provenance: {
			unverified: true,
			confirm: `${UNVERIFIED}; confirm no compatibility flag is needed`
		}
	},
	resources: [],
	durableObjects: [],
	durableMigrations: [],
	crons: [],
	assets: {
		directory: null,
		provenance: {
			unverified: true,
			confirm: `${UNVERIFIED}; confirm the build output directory`
		}
	},
	refused: [],
	secrets: [],
	variables: [],
	firstRun: null,
	probe: {
		method: 'GET',
		path: '/',
		provenance: { unverified: true, confirm: `${UNVERIFIED}; confirm the root answers 200` }
	},
	settings: [],
	release: {
		workerAsset: null,
		provenance: {
			unverified: true,
			confirm: `${UNVERIFIED}; confirm there is no Worker release`
		}
	}
};
