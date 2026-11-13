import { sha256Hex } from '@contracts/common';
import type { Site } from '@contracts/sites';
import { checkHostname } from '../../shared/domain-copy';
import { isValidName, suffixOwner } from '../../shared/names';

// each found site costs an audit append and a row write, and a Worker invocation has a bounded
// number of subrequests; the rest wait for the next frame
export const MAX_FOUND_PER_FRAME = 25;

// a site the dashboard just made or found is not read as gone for a while: a status frame sent
// before the box finished adding it would otherwise flag it
export const NEW_SITE_GRACE_MS = 10 * 60_000;

const NAME_LIMIT = 100;
const SLUG_LIMIT = 63;
const TOKEN = /^h:[0-9a-f]{24}$/;

export const isBoxToken = (name: string): boolean => TOKEN.test(name);

// the name a box that hashes sends for a site: the same digest the bastion computes over the node id
// and the host, cut to 24 hex digits
export async function boxToken(nodeId: string, host: string): Promise<string> {
	return `h:${(await sha256Hex(`${nodeId}\n${host}`)).slice(0, 24)}`;
}

export interface KnownBoxSite {
	id: string;
	name: string;
	host: string | null;
	foundAs: string | null;
	nodeId: string | null;
	state: Site['state'];
	readyAt: number | null;
	missingSince: number | null;
}

export interface BoxFrame {
	names: readonly string[];
	hashed: boolean;
}

export interface FoundBoxSite {
	name: string;
	host: string | null;
	foundAs: string;
}

export interface LearnedHost {
	id: string;
	host: string;
}

export interface BoxSiteChanges {
	create: FoundBoxSite[];
	// a found site first seen under a hashed name, now seen under its host
	learn: LearnedHost[];
	markMissing: string[];
	markPresent: string[];
	unchanged: string[];
	// reported names the dashboard could not use, and found sites left for the next frame
	ignored: number;
	skipped: number;
}

export interface BoxSiteInput {
	nodeId: string;
	// what the owner calls this box; names a found site that has none of its own to show
	nodeLabel: string;
	known: readonly KnownBoxSite[];
	frame: BoxFrame;
	// the hashed name of a host as this node would send it
	tokenOf: (host: string) => string;
	now: number;
	maxCreate?: number;
}

const live = (row: KnownBoxSite): boolean => row.state === 'active' || row.state === 'suspended';

// a found site the owner removed stays as a deleted row, so a box that still reports it is not read
// as a new one
const dismissed = (row: KnownBoxSite): boolean => row.state === 'deleted' && row.foundAs !== null;

const slug = (text: string): string =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

function fit(base: string, suffix: string): string {
	const room = SLUG_LIMIT - suffix.length;
	return `${base.slice(0, Math.max(0, room)).replace(/-+$/g, '')}${suffix}`;
}

// the host as a three-word style name: lowercase, hyphens, reserved endings refused. A collision
// takes the box's own name as a suffix, then a count, never a random word; null when nothing fits
export function nameForHost(
	host: string,
	nodeLabel: string,
	taken: ReadonlySet<string>
): string | null {
	const base = slug(host);
	const node = slug(nodeLabel) || 'box';
	const usable = (name: string): boolean =>
		isValidName(name) && suffixOwner(name) === null && !taken.has(name);
	const plain = fit(base, '');
	if (usable(plain)) return plain;
	for (let count = 1; count <= 99; count++) {
		const name = fit(base, count === 1 ? `-${node}` : `-${node}-${count}`);
		if (usable(name)) return name;
	}
	return null;
}

// "Site 1 on <box>": the smallest number not yet used
export function neutralName(nodeLabel: string, taken: ReadonlySet<string>): string {
	const label = nodeLabel.slice(0, 60);
	for (let count = 1; ; count++) {
		const name = `Site ${count} on ${label}`.slice(0, NAME_LIMIT);
		if (!taken.has(name)) return name;
	}
}

interface Reported {
	names: string[];
	ignored: number;
}

// sorted and without repeats, so the same set in any order is one input; a clear name that is not a
// host this dashboard could list, and a hashed name that is not a token, are counted and dropped
function reported(frame: BoxFrame): Reported {
	const seen = new Set<string>();
	let ignored = 0;
	for (const raw of frame.names) {
		const name = frame.hashed ? raw : checkHostnameName(raw);
		if (name === null || (frame.hashed && !isBoxToken(name))) {
			ignored++;
			continue;
		}
		seen.add(name);
	}
	return { names: [...seen].sort(), ignored };
}

function checkHostnameName(raw: string): string | null {
	const checked = checkHostname(raw);
	return checked.ok ? checked.hostname : null;
}

function aliasesOf(row: KnownBoxSite, tokenOf: (host: string) => string): Set<string> {
	const aliases = new Set<string>();
	const host = row.host?.toLowerCase() ?? null;
	if (host !== null) {
		aliases.add(host);
		aliases.add(tokenOf(host));
	}
	if (row.foundAs !== null) {
		aliases.add(row.foundAs);
		if (!isBoxToken(row.foundAs)) aliases.add(tokenOf(row.foundAs));
	}
	return aliases;
}

// the decisions a status frame's site list makes about the rows of one node. Pure: the same rows
// and the same set of names give the same answer in any order, and applying the answer then asking
// again changes nothing
export function reconcileBoxSites(input: BoxSiteInput): BoxSiteChanges {
	const { nodeId, tokenOf, now } = input;
	const cap = input.maxCreate ?? MAX_FOUND_PER_FRAME;
	const { names, ignored } = reported(input.frame);
	const rows = [...input.known]
		.filter((row) => live(row) || dismissed(row))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const aliases = new Map(rows.map((row) => [row.id, aliasesOf(row, tokenOf)] as const));

	const present = new Set<string>();
	const matched = new Set<string>();
	const learn: LearnedHost[] = [];
	for (const name of names) {
		const clear = !isBoxToken(name);
		for (const row of rows) {
			const direct = aliases.get(row.id)?.has(name) === true;
			const viaToken =
				clear &&
				row.foundAs !== null &&
				isBoxToken(row.foundAs) &&
				tokenOf(name) === row.foundAs;
			if (!direct && !viaToken) continue;
			present.add(row.id);
			matched.add(name);
			if (
				viaToken &&
				row.host === null &&
				live(row) &&
				row.nodeId === nodeId &&
				!learn.some((item) => item.id === row.id)
			) {
				learn.push({ id: row.id, host: name });
			}
		}
	}

	const out: BoxSiteChanges = {
		create: [],
		learn,
		markMissing: [],
		markPresent: [],
		unchanged: [],
		ignored,
		skipped: 0
	};
	for (const row of rows) {
		const mine =
			live(row) &&
			row.nodeId === nodeId &&
			row.readyAt !== null &&
			now - row.readyAt >= NEW_SITE_GRACE_MS;
		if (!mine) out.unchanged.push(row.id);
		else if (present.has(row.id)) {
			(row.missingSince === null ? out.unchanged : out.markPresent).push(row.id);
		} else {
			(row.missingSince === null ? out.markMissing : out.unchanged).push(row.id);
		}
	}

	const fresh = names.filter((name) => !matched.has(name));
	const taken = new Set(rows.filter(live).map((row) => row.name));
	for (const name of fresh.slice(0, cap)) {
		if (isBoxToken(name)) {
			const label = neutralName(input.nodeLabel, taken);
			taken.add(label);
			out.create.push({ name: label, host: null, foundAs: name });
			continue;
		}
		const chosen =
			nameForHost(name, input.nodeLabel, taken) ?? neutralName(input.nodeLabel, taken);
		taken.add(chosen);
		out.create.push({ name: chosen, host: name, foundAs: name });
	}
	out.skipped = fresh.length - out.create.length;
	return out;
}

// the hash of every host this frame or these rows could be compared by; a host outside the set has
// no hash, and the empty string matches nothing
export async function tokensFor(
	nodeId: string,
	known: readonly KnownBoxSite[],
	frame: BoxFrame
): Promise<(host: string) => string> {
	const hosts = new Set<string>();
	for (const row of known) {
		if (row.host !== null) hosts.add(row.host.toLowerCase());
		if (row.foundAs !== null && !isBoxToken(row.foundAs)) hosts.add(row.foundAs);
	}
	if (!frame.hashed) for (const name of reported(frame).names) hosts.add(name);
	const tokens = new Map<string, string>();
	for (const host of hosts) tokens.set(host, await boxToken(nodeId, host));
	return (host) => tokens.get(host) ?? '';
}

// stable for a given set, whatever its order and whether or not names are hashed; the link keeps it
// to skip a frame that says what the last one did
export async function frameDigest(frame: BoxFrame): Promise<string> {
	const { names } = reported(frame);
	return sha256Hex(JSON.stringify({ hashed: frame.hashed, names }));
}
