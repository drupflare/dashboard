import { describe, expect, it } from 'vitest';
import {
	appendHistory,
	buildHealthTree,
	worse,
	type HealthNode
} from '../../../src/server/domain/health-tree';

const find = (nodes: HealthNode[], id: string): HealthNode => {
	const hit = nodes.find((n) => n.id === id);
	if (!hit) throw new Error(`no node ${id}`);
	return hit;
};

describe('buildHealthTree', () => {
	it('puts each finding on one node with its catalogue handle', () => {
		const tree = buildHealthTree({
			findings: [
				{
					code: 'render.empty',
					severity: 'critical',
					scope: '/',
					context: '200 with 0 bytes'
				}
			]
		});
		const node = find(tree.nodes, 'supervisor');
		expect(node.state).toBe('findings');
		expect(node.children[0]).toMatchObject({
			id: 'supervisor.render.empty',
			level: 'critical',
			handle: '/invalidate'
		});
		expect(tree.level).toBe('critical');
	});

	it('leaves the handle null for a finding with no catalogue row', () => {
		const tree = buildHealthTree({
			findings: [{ code: 'no.such.code', severity: 'warn', scope: '', context: '' }]
		});
		expect(find(tree.nodes, 'supervisor').children[0]?.handle).toBeNull();
	});

	it('gives every owed reconcile step the reconcile handle', () => {
		const tree = buildHealthTree({
			reconcile: {
				version: 3,
				packVersion: 4,
				steps: [
					{ id: 'owner-tiers', state: 'owed', describe: 'tiers', detail: '' },
					{ id: 'image-toolkit', state: 'satisfied', describe: 'toolkit', detail: '' }
				]
			}
		});
		const chain = find(tree.nodes, 'reconcile');
		expect(chain.state).toBe('behind');
		const owed = find(chain.children, 'reconcile.owner-tiers');
		expect(owed).toMatchObject({ state: 'owed', level: 'warn', handle: 'reconcile' });
		expect(find(chain.children, 'reconcile.image-toolkit').level).toBe('ok');
	});

	it('shows a quarantined repair ladder as critical', () => {
		const tree = buildHealthTree({
			repair: { rung: 'quarantine', code: 'render.empty', strikes: 3 }
		});
		expect(find(tree.nodes, 'repair')).toMatchObject({
			level: 'critical',
			state: 'quarantine'
		});
		expect(tree.level).toBe('critical');
	});

	it('reports ok for a clean site', () => {
		const tree = buildHealthTree({
			repair: { rung: 'observe', code: null, strikes: 0 }
		});
		expect(tree.level).toBe('ok');
	});

	it('attaches each node its own history', () => {
		const history = {
			'supervisor.render.empty': [{ state: 'critical', atMs: 1 }]
		};
		const tree = buildHealthTree({
			findings: [{ code: 'render.empty', severity: 'critical', scope: '/', context: '' }],
			history
		});
		expect(find(tree.nodes, 'supervisor').children[0]?.history).toEqual(
			history['supervisor.render.empty']
		);
	});
});

describe('appendHistory', () => {
	it('records a change of state and skips a repeat', () => {
		let h = appendHistory({}, 'repair', 'observe', 1);
		h = appendHistory(h, 'repair', 'observe', 2);
		h = appendHistory(h, 'repair', 'quarantine', 3);
		expect(h.repair).toEqual([
			{ state: 'observe', atMs: 1 },
			{ state: 'quarantine', atMs: 3 }
		]);
	});

	it('does not change the input map', () => {
		const before = {};
		appendHistory(before, 'repair', 'observe', 1);
		expect(before).toEqual({});
	});
});

describe('worse', () => {
	it('returns the higher level on the shared scale', () => {
		expect(worse('warn', 'error')).toBe('error');
		expect(worse('critical', 'ok')).toBe('critical');
	});
});
