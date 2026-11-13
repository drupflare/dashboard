import { describe, expect, it } from 'vitest';
import { keyUsable } from '../../../src/server/domain/scopes';
import { EXPIRY_PRESETS } from '../../../src/server/services/api-keys';
import {
	claudeMcpAddCommand,
	KEY_EXPIRY_LABELS,
	KEY_EXPIRY_PRESETS,
	KEY_PLACEHOLDER,
	KEY_RECENT_USE_MS,
	KEY_SCOPE_COPY,
	KEY_SCOPE_GROUPS,
	keyCreateBodySchema,
	keyStateOf,
	keyUsedRecently,
	mcpUrl,
	scopeSections
} from '../../../src/shared/api-keys';
import { ACTIONS } from '../../../src/shared/permissions';

const REAL_KEY = 'dfk_0123456789ab_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

describe('claudeMcpAddCommand', () => {
	it('builds the command with a placeholder where the key goes', () => {
		expect(claudeMcpAddCommand()).toBe(
			`claude mcp add --transport http drupflare 'https://mymcp.gmitch215.xyz/drupflare/mcp' --header "X-Mcp-Upstream-Authorization: Bearer ${KEY_PLACEHOLDER}"`
		);
		expect(KEY_PLACEHOLDER).toBe('<paste the key>');
	});

	it('adds filters to the address and quotes it so a shell keeps the question mark', () => {
		expect(claudeMcpAddCommand({ methods: ['get'], confirm: 'write' })).toContain(
			`'https://mymcp.gmitch215.xyz/drupflare/mcp?methods=get&confirm=write'`
		);
		expect(mcpUrl({ tags: ['sites', 'nodes'], methods: ['get', 'post'] })).toBe(
			'https://mymcp.gmitch215.xyz/drupflare/mcp?tags=sites,nodes&methods=get,post'
		);
	});

	it('encodes a filter value and skips empty lists', () => {
		expect(mcpUrl({ tags: ['a b'], methods: [] })).toBe(
			'https://mymcp.gmitch215.xyz/drupflare/mcp?tags=a%20b'
		);
		expect(mcpUrl({})).toBe('https://mymcp.gmitch215.xyz/drupflare/mcp');
	});

	it('puts a real key in the header and never in the address', () => {
		const command = claudeMcpAddCommand({ methods: ['get'] }, REAL_KEY);
		expect(command).toContain(`Bearer ${REAL_KEY}"`);
		const address = /'([^']+)'/.exec(command)![1]!;
		expect(address).not.toContain('dfk_');
		expect(new URL(address).host).toBe('mymcp.gmitch215.xyz');
		for (const filters of [
			{},
			{ methods: ['get'] },
			{ tags: ['x'], confirm: 'all' as const }
		]) {
			expect(mcpUrl(filters)).not.toContain('dfk_');
		}
	});
});

describe('key state', () => {
	const NOW = Date.parse('2026-11-13T12:00:00.000Z');
	const at = (ms: number) => new Date(ms).toISOString();

	it('reads revoked before expired before active', () => {
		expect(keyStateOf({ expiresAt: null, revokedAt: null }, NOW)).toBe('active');
		expect(keyStateOf({ expiresAt: at(NOW + 1), revokedAt: null }, NOW)).toBe('active');
		expect(keyStateOf({ expiresAt: at(NOW), revokedAt: null }, NOW)).toBe('expired');
		expect(keyStateOf({ expiresAt: at(NOW - 1), revokedAt: at(NOW - 5) }, NOW)).toBe('revoked');
	});

	it('counts a key as recently used for one day', () => {
		expect(keyUsedRecently({ lastUsedAt: null }, NOW)).toBe(false);
		expect(keyUsedRecently({ lastUsedAt: at(NOW - KEY_RECENT_USE_MS + 1) }, NOW)).toBe(true);
		expect(keyUsedRecently({ lastUsedAt: at(NOW - KEY_RECENT_USE_MS) }, NOW)).toBe(false);
		expect(keyUsedRecently({ lastUsedAt: 'not a date' }, NOW)).toBe(false);
	});
});

describe('create body', () => {
	const good = { name: ' ci ', scopes: ['org.read'], expiry: '90d' };

	it('trims the name and takes only the expiry presets the server knows', () => {
		expect(keyCreateBodySchema.parse(good).name).toBe('ci');
		expect(Object.keys(EXPIRY_PRESETS)).toEqual([...KEY_EXPIRY_PRESETS]);
		expect(Object.keys(KEY_EXPIRY_LABELS)).toEqual([...KEY_EXPIRY_PRESETS]);
	});

	it.each([
		['an empty name', { ...good, name: '  ' }],
		['no scopes', { ...good, scopes: [] }],
		['an unknown expiry', { ...good, expiry: '1d' }],
		['an extra field', { ...good, siteIds: [] }]
	])('refuses %s', (_label, body) => {
		expect(keyCreateBodySchema.safeParse(body).success).toBe(false);
	});
});

describe('scope copy', () => {
	it('has a line and a group for every action a key can hold, and for nothing else', () => {
		const usable = ACTIONS.filter((action) => keyUsable(action));
		expect(Object.keys(KEY_SCOPE_COPY).toSorted()).toEqual([...usable].toSorted());
		const groups = new Set(KEY_SCOPE_GROUPS.map((group) => group.id));
		for (const [action, copy] of Object.entries(KEY_SCOPE_COPY)) {
			expect(groups.has(copy.group), action).toBe(true);
			expect(copy.label.length, action).toBeGreaterThan(0);
		}
	});

	it('shows no action name, dot or underscore in a label', () => {
		for (const { label } of Object.values(KEY_SCOPE_COPY))
			expect(label).toMatch(/^[A-Za-z -]+$/);
	});

	it('sections only what is offered, in group order, and drops empty groups', () => {
		const sections = scopeSections([
			'org.read',
			'site.read',
			'site.deploy',
			'admin.audit.read',
			'x'
		]);
		expect(sections.map((section) => section.id)).toEqual(['sites', 'team']);
		expect(sections[0]!.choices.map((choice) => choice.action)).toEqual([
			'site.read',
			'site.deploy'
		]);
		expect(scopeSections([])).toEqual([]);
	});
});
