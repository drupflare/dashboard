import assert from 'node:assert/strict';
import { test } from 'node:test';
import { residency } from './residency.mjs';

test('two objects in one module instance see each other', () => {
	const a1 = residency('a', 0);
	const b1 = residency('b', 1_000);
	const a2 = residency('a', 2_000);
	assert.equal(a1.split(';')[1], 'others=0');
	assert.equal(b1.split(';')[1], 'others=1');
	assert.equal(a2.split(';')[1], 'others=1');
	assert.equal(a1.split(';')[0], b1.split(';')[0]);
});

test('a neighbour drops out after the window', () => {
	residency('c', 500_000);
	residency('d', 500_100);
	assert.equal(residency('c', 500_200).split(';')[1], 'others=1');
	assert.equal(residency('c', 500_200 + 120_000).split(';')[1], 'others=0');
});
