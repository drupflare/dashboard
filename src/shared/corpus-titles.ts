export type CorpusTitle = { title: string; summary: string };

// the manifest names a codebase by its key; these are the names people know it by, and one line
// from each repository's own description
export const CORPUS_TITLES: Record<string, CorpusTitle> = {
	entity_reference_integrity: {
		title: 'Entity Reference Integrity',
		summary: 'A module that keeps content references intact.'
	},
	activity_finder: {
		title: 'OpenY Activity Finder',
		summary: 'Activity search for sites built on OpenY.'
	},
	simple_oauth_21: {
		title: 'Simple OAuth 2.1',
		summary: 'OAuth 2.1 on top of the Simple OAuth module.'
	},
	mantle2: {
		title: 'Earth App Backend',
		summary: "The Earth App's backend API, written as a Drupal module."
	},
	webcms: { title: 'EPA WebCMS', summary: "The content system behind the EPA's website." },
	farmos: { title: 'farmOS', summary: 'Record keeping for farms.' },
	open_social: { title: 'Open Social', summary: 'An install profile for community sites.' },
	yusaopeny: { title: 'OpenY', summary: "The YMCA's website platform." },
	thunder: { title: 'Thunder', summary: 'A platform for professional publishers.' },
	varbase: { title: 'Varbase', summary: 'A pre-configured Drupal distribution from Vardot.' },
	govcms: { title: 'GovCMS', summary: 'The main GovCMS distribution.' },
	herbie: {
		title: 'Project Herbie',
		summary: "The University of Nebraska-Lincoln's Drupal 11 site."
	},
	openculturas: {
		title: 'openCulturas',
		summary: 'A Drupal distribution for cultural organizations.'
	},
	droopler: { title: 'Droopler', summary: 'A Drupal distribution from Droptica.' },
	localgov_microsites: {
		title: 'LocalGov Microsites',
		summary: 'A project template for LocalGov Drupal microsites.'
	},
	essex: { title: 'Essex Intranet', summary: "Essex County Council's intranet." },
	atelier: {
		title: 'Atelier CMS',
		summary: 'A self-hosted AI website builder on Drupal.'
	},
	openintranet: {
		title: 'Open Intranet',
		summary: 'A workplace hub for news, documents and people.'
	},
	islandora: {
		title: 'Islandora',
		summary: 'Modules for browsing and managing digital repositories.'
	},
	ymca360: { title: 'OpenY YMCA360', summary: 'The YMCA360 integration for OpenY.' },
	strawberryfield: { title: 'Strawberryfield', summary: 'A core module of Archipelago.' },
	fairwell: {
		title: 'Farewell Drupal',
		summary: 'A bundle of modules, including site tooling, vector search and AI providers.'
	},
	migration_example: {
		title: 'Migration Example',
		summary: 'Examples of writing custom Drupal migrations.'
	},
	fflch: { title: 'FFLCH Drupal', summary: "The FFLCH faculty's Drupal platform." },
	drupalx: {
		title: 'DrupalX',
		summary: 'A project template for the DrupalX theme and installation.'
	},
	lagoon_cachebackend: {
		title: 'Lagoon Redis Example',
		summary: 'A Drupal example that uses Redis as its cache backend.'
	},
	varbase_patches: {
		title: 'Varbase Patches',
		summary: 'The patches Varbase applies with Composer Patches.'
	},
	panopoly: { title: 'Panopoly', summary: 'A Drupal 7 distribution.' },
	commerce_kickstart: {
		title: 'Commerce Kickstart',
		summary: 'A Drupal 7 install profile for Drupal Commerce.'
	},
	dkan7: { title: 'DKAN', summary: 'A Drupal 7 open data portal.' }
};

const WORDS_LOWER = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for']);

// an id with no entry above still reads as words
export function corpusTitle(id: string): CorpusTitle {
	const known = CORPUS_TITLES[id];
	if (known) return known;
	const words = id.split(/[_-]+/).filter(Boolean);
	const title = words
		.map((word, at) =>
			at > 0 && WORDS_LOWER.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)
		)
		.join(' ');
	return { title: title || id, summary: '' };
}
