import assert from 'node:assert/strict';
import { test } from 'node:test';
import { residency } from './residency.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('the instance id is created on the first call and reused', () => {
	const a = residency('lazy-a', 1, 0);
	const b = residency('lazy-b', 1, 1);
	assert.match(a.instance, UUID);
	assert.equal(a.instance, b.instance);
});

// each test starts a window-length later so entries from earlier tests have expired
test('two objects in one module instance see each other and their bytes', () => {
	const base = 1_000_000;
	const a1 = residency('a', 100, base);
	const b1 = residency('b', 300, base + 1000);
	const a2 = residency('a', 100, base + 2000);
	assert.equal(a1.others, 0);
	assert.equal(b1.others, 1);
	assert.equal(b1.otherBytes, 100);
	assert.equal(a2.others, 1);
	assert.equal(a2.otherBytes, 300);
	assert.equal(a1.instance, b1.instance);
});

test('a neighbour drops out after the window', () => {
	const base = 3_000_000;
	residency('c', 10, base);
	residency('d', 20, base + 100);
	assert.equal(residency('c', 10, base + 200).others, 1);
	assert.equal(residency('c', 10, base + 200 + 120000).others, 0);
});
