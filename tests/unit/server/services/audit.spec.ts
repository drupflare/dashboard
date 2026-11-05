import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, hashEntry } from '../../../../src/server/services/audit';

const entry = {
	organization_id: 'org-1',
	seq: 0,
	actor: 'user-1',
	action: 'member.invite',
	target: 'invite-1',
	detail: '{}',
	created_at: 1_700_000_000_000
};

describe('canonicalJson', () => {
	it('sorts keys at every depth and drops undefined members', () => {
		const value = { b: 1, a: { d: [2, { z: null, y: 'x' }], c: undefined } };
		expect(canonicalJson(value)).toBe('{"a":{"d":[2,{"y":"x","z":null}]},"b":1}');
	});

	it('keeps array order', () => {
		expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
	});
});

describe('hashEntry', () => {
	it('is the sha256 of the previous hash followed by the canonical entry', async () => {
		const expected = createHash('sha256')
			.update('abc' + canonicalJson(entry))
			.digest('hex');
		expect(await hashEntry('abc', entry)).toBe(expected);
	});

	it('changes when the previous hash changes', async () => {
		expect(await hashEntry('a', entry)).not.toBe(await hashEntry('b', entry));
	});

	it('changes when an entry field changes', async () => {
		expect(await hashEntry('', entry)).not.toBe(
			await hashEntry('', { ...entry, actor: 'user-2' })
		);
	});
});
