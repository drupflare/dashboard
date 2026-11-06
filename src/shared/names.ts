// curated for profanity, brands and lookalikes; a generated name is adjective-noun-noun
export const ADJECTIVES: readonly string[] = `
able agile airy amber ample arid ashen balmy bare bold brisk broad bronze candid clean clever
coral cozy crisp cubic curly dainty dapper dark deep dense dewy direct dusky dusty eager early
earnest easy even exact fair fast fern fierce fine firm flat floral focal fond frank fresh
friendly frosty full gentle glad glassy golden good grand grassy great green hardy hazel hearty
heavy high honest humble icy ideal jade jolly jovial keen kind knotty lively local lofty lunar
lush mellow mild misty modest moss muted neat noble nutty ochre olive open pale plain plucky
plum pithy pure ready real rich rigid ripe rustic sandy satin savvy scenic silver simple sleek
slim smart snowy solid spry stable steady stout sunny tawny tidy tranquil true tulip urban vivid
warm wavy witty zesty breezy bright chilly cosmic crafty dreamy dry flinty gusty hasty hilly
humid jaunty leafy level lilac marine mossy nifty orderly plush quaint rainy rocky rosy salty
sincere sturdy sweet tender thick timely upbeat velvet verdant whole windy young zippy bumpy
crooked sable
`
	.trim()
	.split(/\s+/);

export const NOUNS: readonly string[] = `
acorn alder anvil arbor arch badger bamboo barn basil bay bee birch bison blossom boulder brook
bunny butte cabin cactus canal canyon cape cliff clover comet coyote crane creek crest crow dale
daisy dawn dingo dune eagle field finch fjord flint forest fox frost garden geyser glade glen
grove gull harbor hare hawk heron hill hollow horizon ibis inlet iris island ivy jasper kestrel
kiwi lagoon lake lantern larch lark lava ledge lemur lichen lily linden lynx maple marsh meadow
mesa mist moon moose mountain nest newt oak oasis orbit orchid otter owl pebble pelican pine
plateau plover pond poplar prairie quail quarry quartz raven reef ridge river robin rowan sail
salmon shore sparrow spruce squirrel starling stone storm summit swallow tern thicket thistle
tiger timber torch trail trout valley vine violet walnut wave weasel willow wind wolf wren
yarrow yew zephyr cypress bluff bramble cove dell heath knoll marlin pier quill reed bridge
cairn glacier grotto hamlet meander plume sprout thorn tide
`
	.trim()
	.split(/\s+/);

// platform names nobody may obtain
export const RESERVED_WORDS: readonly string[] = [
	'app',
	'status',
	'docs',
	'api',
	'www',
	'admin',
	'gate'
];

const MAX_ATTEMPTS = 100;
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const HASH_PREFIX = /^[0-9a-f]{8}-/;
const PREVIEW_SUFFIX = /-preview-\d+$/;

// a draw in [0, 1)
export type RandomSource = () => number;

export class NameExhaustedError extends Error {
	constructor() {
		super(`no unused name found in ${MAX_ATTEMPTS} attempts`);
	}
}

function pickIndex(length: number, random: RandomSource): number {
	return Math.min(length - 1, Math.floor(random() * length));
}

export function generateName(random: RandomSource): string {
	const adjective = ADJECTIVES[pickIndex(ADJECTIVES.length, random)];
	const first = pickIndex(NOUNS.length, random);
	const other = pickIndex(NOUNS.length - 1, random);
	const second = other >= first ? other + 1 : other;
	return `${adjective}-${NOUNS[first]}-${NOUNS[second]}`;
}

export function generateUniqueName(random: RandomSource, taken: ReadonlySet<string>): string {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const name = generateName(random);
		if (!taken.has(name) && !isReserved(name)) return name;
	}
	throw new NameExhaustedError();
}

export function isValidName(name: string): boolean {
	return name.length >= 3 && name.length <= 63 && LABEL.test(name) && !name.includes('--');
}

// returns who may obtain a reserved name, or null when the name is free to claim
export function suffixOwner(name: string): 'nobody' | 'paid-managed' | null {
	if (RESERVED_WORDS.includes(name)) return 'nobody';
	if (
		name.endsWith('-staging') ||
		name.endsWith('-dev') ||
		PREVIEW_SUFFIX.test(name) ||
		HASH_PREFIX.test(name)
	) {
		return 'paid-managed';
	}
	return null;
}

export function isReserved(name: string): boolean {
	return suffixOwner(name) !== null;
}

// changing this re-homes every name, so it only grows with a migration
export const NAME_SHARDS = 16;

// fnv-1a over utf-16 code units; names are ascii so this is stable across runtimes
export function hashName(name: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		hash ^= name.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export function shardOf(name: string, shards: number = NAME_SHARDS): number {
	return hashName(name) % shards;
}

// the Durable Object name of the shard that owns a name
export function shardKey(name: string, shards: number = NAME_SHARDS): string {
	return `shard-${shardOf(name, shards)}`;
}

function seededSource(seed: string | number): RandomSource {
	let state = hashName(String(seed));
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// the same seed always gives the same name, so a retried create proposes the same suggestion
export function suggest(seed: string | number): string {
	return generateUniqueName(seededSource(seed), new Set());
}
