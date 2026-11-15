import { z } from 'zod';
import type { LeverDomain, RegistryEntry, SettingPermission } from './registry';

export const leverDomainSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('int'),
		min: z.number(),
		max: z.number(),
		unit: z.enum(['ms', 'bytes']).optional(),
		default: z.number().optional(),
		marks: z
			.array(z.object({ value: z.number(), label: z.string(), note: z.string() }))
			.optional()
	}),
	z.object({ kind: z.literal('flag'), default: z.enum(['0', '1']).optional() }),
	z.object({
		kind: z.literal('enum'),
		values: z.array(z.string()),
		default: z.string().optional()
	}),
	z.object({ kind: z.literal('bins') }),
	z.object({ kind: z.literal('rules') })
]);

// the body of GET /settings (src/site/deployment.ts settingsRoute)
export const settingsResponseSchema = z.object({
	ok: z.literal(true),
	levers: z.array(
		z.object({
			name: z.string(),
			value: z.string().nullable(),
			source: z.enum(['kv', 'var', 'default']),
			domain: leverDomainSchema
		})
	)
});

export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

function domainSchema(domain: LeverDomain): Record<string, unknown> {
	switch (domain.kind) {
		case 'int':
			return {
				type: 'integer',
				minimum: domain.min,
				maximum: domain.max,
				...(domain.default !== undefined ? { default: domain.default } : {}),
				...(domain.unit !== undefined ? { 'x-unit': domain.unit } : {}),
				...(domain.marks !== undefined ? { 'x-marks': domain.marks } : {})
			};
		case 'flag':
			return {
				type: 'string',
				enum: ['0', '1'],
				...(domain.default !== undefined ? { default: domain.default } : {})
			};
		case 'enum':
			return {
				type: 'string',
				enum: [...domain.values],
				...(domain.default !== undefined ? { default: domain.default } : {})
			};
		case 'bins':
		case 'rules':
		case 'text':
			return { type: 'string' };
	}
}

export function propertySchema(
	name: string,
	domain: LeverDomain,
	permission: SettingPermission,
	meta: RegistryEntry | undefined
): Record<string, unknown> {
	const widget = meta?.widget ?? (domain.kind === 'rules' ? 'json' : undefined);
	return {
		...domainSchema(domain),
		title: meta?.label ?? name,
		...(meta?.note !== undefined ? { description: meta.note } : {}),
		'x-ui': {
			group: permission,
			permission,
			...(widget !== undefined ? { widget } : {}),
			...(meta?.danger ? { danger: true } : {})
		}
	};
}

// an int lever arrives as text; the form and the schema work on the number
export function valueOf(lever: SettingsResponse['levers'][number]): unknown {
	if (lever.domain.kind === 'int' && lever.value !== null && /^-?\d+$/.test(lever.value.trim())) {
		return Number(lever.value);
	}
	return lever.value;
}
