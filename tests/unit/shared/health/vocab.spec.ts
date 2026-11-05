import { describe, expect, it } from 'vitest';
import {
	HEALTH_LEVELS,
	RECONCILE_STATES,
	RUNGS,
	SEVERITY_LEVELS,
	STEP_VERDICT_STATES
} from '../../../../src/shared/health/vocab';

// names recorded from the worker tree (worker/src/ops) on 2026-11-05
describe('health vocabulary matches the worker', () => {
	it('uses the worker health levels', () => {
		expect([...HEALTH_LEVELS]).toEqual(['ok', 'info', 'warn', 'error', 'critical']);
	});

	it('uses the worker severity ladder', () => {
		expect([...SEVERITY_LEVELS]).toEqual(['info', 'warn', 'error', 'critical']);
	});

	it('uses the worker repair rungs in order', () => {
		expect([...RUNGS]).toEqual([
			'observe',
			'reset',
			'reconstruct',
			'reconfigure',
			'quarantine',
			'rollback'
		]);
	});

	it('uses the worker reconcile step verdicts and report states', () => {
		expect([...STEP_VERDICT_STATES]).toEqual(['satisfied', 'owed', 'deferred']);
		expect([...RECONCILE_STATES]).toEqual([
			'satisfied',
			'applied',
			'owed',
			'deferred',
			'failed'
		]);
	});
});
