import { describe, expect, it } from 'vitest';
import {
	E2E_APPROVED_TEMPLATE_IDS,
	TEMPLATE_CATEGORIES,
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

	it('gives every enabled entry a category', () => {
		for (const item of TEMPLATES.filter((entry) => entry.enabled)) {
			expect(TEMPLATE_CATEGORIES, item.id).toContain(item.category);
		}
	});

	it('puts Drupal, WordPress and Joomla in cms and the Workers templates in workers', () => {
		for (const id of ['drupal', 'wordpress', 'joomla'])
			expect(template(id).category).toBe('cms');
		for (const id of ['nuxtpress', 'smoke', 'mylora', 'static-site', 'bring-your-own']) {
			expect(template(id).category).toBe('workers');
		}
	});

	it('marks the first-party entries free and the custom Worker paid', () => {
		for (const id of ['drupal', 'nuxtpress', 'smoke', 'mylora', 'static-site']) {
			expect(template(id).free).toBe(true);
		}
		expect(template('bring-your-own').free).toBe(false);
		for (const item of TEMPLATES.filter((entry) => entry.planGate === 'free')) {
			expect(item.free, item.id).toBe(true);
		}
	});

	it('assigns the roadmap classes and leaves unclassed kinds null', () => {
		expect(TEMPLATE_CLASSES).toEqual(['first', 'second', 'third']);
		expect(template('drupal').class).toBe('first');
		for (const id of ['wordpress', 'joomla', 'nuxtpress']) {
			expect(template(id).class).toBe('second');
		}
		for (const id of ['smoke', 'mylora']) expect(template(id).class).toBe('third');
		for (const id of ['static-site', 'gmux', 'bring-your-own']) {
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
