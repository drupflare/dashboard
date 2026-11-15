import { describe, expect, it } from 'vitest';
import {
	TEMPLATES,
	buildsInAllowance,
	containerCost,
	containerOption,
	installOption,
	table
} from '../../../scripts/economics/template-delivery';

const [thunder, govcms, farmos] = TEMPLATES;

describe('template delivery pricing', () => {
	it('prices an hour on the standard-2 shape at the published rate', () => {
		expect(containerCost(3600)).toBeCloseTo(0.129, 4);
	});

	it('lets memory bind the monthly allowance for a six gibibyte instance', () => {
		expect(buildsInAllowance(176.3)).toBe(85);
		expect(buildsInAllowance(48.4)).toBe(309);
		expect(buildsInAllowance(47.3)).toBe(317);
	});

	it('shows that no template tree fits a single worker bundle', () => {
		for (const template of TEMPLATES) {
			expect(containerOption(template).fitsWorkerBundle).toBe(false);
		}
	});

	it('counts the upload groups between the compressed and the raw size', () => {
		const calls = containerOption(thunder!).modifyCalls;
		expect(calls.min).toBe(52);
		expect(calls.max).toBe(190);
		expect(calls.min).toBeLessThan(calls.max);
	});

	it('needs one install call per forty packages and leaves rows and time unknown', () => {
		expect(installOption(thunder!)).toMatchObject({
			installCalls: 5,
			enableCalls: 1,
			rowsWritten: null,
			wallSeconds: null
		});
		expect(installOption(govcms!).installCalls).toBe(7);
		expect(installOption(farmos!).installCalls).toBe(4);
		expect(installOption(thunder!).objectRequestCost).toBeLessThan(0.000001);
	});

	it('prints a row per template', () => {
		const lines = table().split('\n');
		expect(lines).toHaveLength(TEMPLATES.length + 1);
		expect(lines.slice(1).every((line) => line.endsWith('| unknown'))).toBe(true);
	});
});
