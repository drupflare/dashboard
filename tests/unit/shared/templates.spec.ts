import { describe, expect, it } from 'vitest';
import {
	E2E_APPROVED_TEMPLATE_IDS,
	TEMPLATE_CLASSES,
	TEMPLATES
} from '../../../src/shared/templates';

function template(id: string) {
	const found = TEMPLATES.find((item) => item.id === id);
	if (!found) throw new Error(`no template ${id}`);
	return found;
}

describe('templates', () => {
	it('has unique ids', () => {
		const ids = TEMPLATES.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('disables WordPress, Joomla and gmux with the Coming Soon text', () => {
		for (const id of ['wordpress', 'joomla', 'gmux']) {
			expect(template(id).enabled).toBe(false);
			expect(template(id).comingSoon).toBe('Coming Soon');
		}
	});

	it('keeps the first-party templates enabled and free', () => {
		for (const id of ['drupal', 'static-site', 'nuxtpress', 'smoke', 'mylora']) {
			expect(template(id).enabled).toBe(true);
			expect(template(id).planGate).toBe('free');
		}
	});

	it('gates Bring Your Own to paid managed and self-managed sites', () => {
		expect(template('bring-your-own').planGate).toBe('paid-managed-or-self-managed');
		expect(template('bring-your-own').enabled).toBe(true);
	});

	it('lists Import From a Server with no stated gate', () => {
		expect(template('import-from-server').enabled).toBe(true);
		expect(template('import-from-server').planGate).toBe(null);
	});

	it('assigns the roadmap classes and leaves unclassed kinds null', () => {
		expect(TEMPLATE_CLASSES).toEqual(['first', 'second', 'third']);
		expect(template('drupal').class).toBe('first');
		for (const id of ['wordpress', 'joomla', 'nuxtpress']) {
			expect(template(id).class).toBe('second');
		}
		for (const id of ['smoke', 'mylora']) expect(template(id).class).toBe('third');
		for (const id of ['static-site', 'gmux', 'bring-your-own', 'import-from-server']) {
			expect(template(id).class).toBe(null);
		}
	});

	it('lists the e2e approved workers and each one is an enabled template', () => {
		expect(E2E_APPROVED_TEMPLATE_IDS).toEqual([
			'drupal',
			'static-site',
			'nuxtpress',
			'smoke',
			'mylora'
		]);
		for (const id of E2E_APPROVED_TEMPLATE_IDS) expect(template(id).enabled).toBe(true);
	});
});
