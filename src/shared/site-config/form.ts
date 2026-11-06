import { type DiscoveryDocument, KNOWN_WIDGETS } from '@contracts/discovery';
import { z } from 'zod';
import { type Action, type ConfigAction, SITE_ROLE_ACTIONS, type SiteRole } from '../permissions';
import type { SettingPermission } from './registry';

type Settings = DiscoveryDocument['settings'];

export type FieldDescriptor = {
	key: string;
	label: string;
	widget: string;
	bounds: { min?: number; max?: number; unit?: string } | null;
	permission: SettingPermission;
	// the property validate() checks against
	schema: Record<string, unknown>;
	value: unknown;
	provenance: string | null;
	danger: boolean;
	writable: boolean;
	description?: string;
};

export type ValidateResult =
	{ ok: true } | { ok: false; errors: { key: string; message: string }[] };

function canWrite(role: SiteRole, permission: SettingPermission): boolean {
	const action: ConfigAction = `site.config.${permission}.write`;
	return (SITE_ROLE_ACTIONS[role] as readonly Action[]).includes(action);
}

function isFlag(prop: Record<string, unknown>): boolean {
	const values = prop['enum'];
	return Array.isArray(values) && values.length === 2 && values[0] === '0' && values[1] === '1';
}

// an unknown widget reads as a JSON editor, so a new worker widget degrades instead of breaking the form
function widgetOf(prop: Record<string, unknown>): string {
	const ui = prop['x-ui'] as { widget?: string } | undefined;
	if (ui?.widget !== undefined) {
		return (KNOWN_WIDGETS as readonly string[]).includes(ui.widget) ? ui.widget : 'json';
	}
	if (Array.isArray(prop['enum'])) return isFlag(prop) ? 'toggle' : 'select';
	if (prop['type'] === 'integer') return 'number';
	return 'text';
}

function boundsOf(prop: Record<string, unknown>): FieldDescriptor['bounds'] {
	const min = prop['minimum'];
	const max = prop['maximum'];
	if (min === undefined && max === undefined) return null;
	return {
		...(typeof min === 'number' ? { min } : {}),
		...(typeof max === 'number' ? { max } : {}),
		...(typeof prop['x-unit'] === 'string' ? { unit: prop['x-unit'] } : {})
	};
}

// write access is resolved per permission group for the role
export function toFields(settings: Settings, role: SiteRole): FieldDescriptor[] {
	return Object.keys(settings.schema).map((key) => {
		const prop = settings.schema[key] as Record<string, unknown>;
		const ui = prop['x-ui'] as { permission: SettingPermission; danger?: boolean };
		const description = prop['description'];
		return {
			key,
			label: typeof prop['title'] === 'string' ? prop['title'] : key,
			widget: widgetOf(prop),
			bounds: boundsOf(prop),
			permission: ui.permission,
			schema: prop,
			value: settings.values[key],
			provenance: settings.provenance[key] ?? null,
			danger: ui.danger === true,
			writable: settings.writable[key] !== undefined && canWrite(role, ui.permission),
			...(typeof description === 'string' ? { description } : {})
		};
	});
}

// null and an empty string clear an override, which the worker accepts too
export function validate(
	fields: readonly FieldDescriptor[],
	values: Record<string, unknown>
): ValidateResult {
	const byKey = new Map(fields.map((f) => [f.key, f]));
	const errors: { key: string; message: string }[] = [];
	for (const [key, value] of Object.entries(values)) {
		const field = byKey.get(key);
		if (!field) {
			errors.push({ key, message: 'not a setting this site exposes' });
			continue;
		}
		if (!field.writable) {
			errors.push({ key, message: 'read-only for this role' });
			continue;
		}
		if (value === null || value === '') continue;
		const parsed = z.fromJSONSchema(field.schema).safeParse(value);
		if (!parsed.success) {
			errors.push({ key, message: parsed.error.issues[0]?.message ?? 'invalid value' });
		}
	}
	return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
