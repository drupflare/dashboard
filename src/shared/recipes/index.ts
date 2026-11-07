import { z } from 'zod';
import { drupal } from './drupal';
import { mylora } from './mylora';
import { nuxtpress } from './nuxtpress';
import { smoke } from './smoke';
import { staticSite } from './static';

const provenanceSchema = z.union([
	z.strictObject({ source: z.string().min(1) }),
	z.strictObject({ unverified: z.literal(true), confirm: z.string().min(1) })
]);

const passwordClassSchema = z.enum(['lower', 'upper', 'digit', 'symbol']);

const resourceSchema = z.strictObject({
	kind: z.enum(['kv', 'r2', 'd1', 'send_email']),
	binding: z.string().min(1),
	optional: z.boolean(),
	migrationsDir: z.string().optional(),
	migrationsTable: z.string().optional(),
	provenance: provenanceSchema
});

const fieldSchema = z.strictObject({
	name: z.string().min(1),
	value: z.enum(['admin-username', 'admin-email', 'admin-password', 'owner-input']),
	required: z.boolean(),
	minLength: z.number().int().nonnegative().optional(),
	maxLength: z.number().int().positive().optional(),
	pattern: z.string().optional(),
	format: z.literal('email').optional(),
	provenance: provenanceSchema
});

const settingSchema = z.strictObject({
	key: z.string().min(1),
	label: z.string().min(1),
	access: z.literal('read-only'),
	maxLength: z.number().int().positive(),
	format: z.literal('email').optional(),
	provenance: provenanceSchema
});

const secretSchema = z.strictObject({
	name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
	encoding: z.enum(['hex', 'base64']),
	length: z.number().int().positive(),
	required: z.boolean(),
	provenance: provenanceSchema
});

export const recipeSchema = z.strictObject({
	id: z.enum(['drupal', 'nuxtpress', 'smoke', 'mylora', 'static-site', 'bring-your-own']),
	name: z.string().min(1),
	category: z.enum(['workers', 'cms']),
	compatibility: z.strictObject({ flags: z.array(z.string()), provenance: provenanceSchema }),
	resources: z.array(resourceSchema),
	durableObjects: z.array(
		z.strictObject({
			binding: z.string().min(1),
			className: z.string().min(1),
			provenance: provenanceSchema
		})
	),
	durableMigrations: z.array(
		z.strictObject({
			tag: z.string().min(1),
			newSqliteClasses: z.array(z.string()),
			provenance: provenanceSchema
		})
	),
	crons: z.array(z.strictObject({ schedule: z.string().min(1), provenance: provenanceSchema })),
	versionMetadata: z
		.strictObject({ binding: z.string().min(1), provenance: provenanceSchema })
		.optional(),
	assets: z.strictObject({
		directory: z.string().min(1).nullable(),
		provenance: provenanceSchema
	}),
	refused: z.array(
		z.strictObject({
			kind: z.string().min(1),
			binding: z.string().optional(),
			reason: z.string().min(1),
			provenance: provenanceSchema
		})
	),
	secrets: z.array(secretSchema),
	variables: z.array(
		z.strictObject({
			name: z.string().min(1),
			optional: z.boolean(),
			platformSet: z.boolean().optional(),
			provenance: provenanceSchema
		})
	),
	firstRun: z
		.strictObject({
			method: z.literal('POST'),
			path: z.string().startsWith('/'),
			provenance: provenanceSchema,
			body: z.array(fieldSchema),
			settingKeys: z.array(
				z.strictObject({ key: z.string().min(1), provenance: provenanceSchema })
			),
			success: z.strictObject({
				statuses: z.array(z.number().int()),
				provenance: provenanceSchema
			}),
			alreadyDone: z.strictObject({ status: z.number().int(), provenance: provenanceSchema }),
			password: z.strictObject({
				minLength: z.number().int().positive().nullable(),
				maxLength: z.number().int().positive().nullable(),
				requires: z.array(passwordClassSchema),
				generatedLength: z.strictObject({
					value: z.number().int().positive(),
					provenance: provenanceSchema
				}),
				delivery: z.literal('shown-once'),
				provenance: provenanceSchema
			}),
			ownerToken: z
				.strictObject({
					responseField: z.string().min(1),
					delivery: z.literal('shown-once'),
					custody: z.strictObject({
						store: z.string().min(1),
						provenance: provenanceSchema
					}),
					provenance: provenanceSchema
				})
				.optional(),
			// the response fields that name the account the call made; neither is a secret
			admin: z
				.strictObject({
					nameField: z.string().min(1),
					mailField: z.string().min(1),
					provenance: provenanceSchema
				})
				.optional()
		})
		.nullable(),
	probe: z.strictObject({
		method: z.literal('GET'),
		path: z.string().startsWith('/'),
		auth: z.enum(['owner-token']).optional(),
		provenance: provenanceSchema
	}),
	settings: z.array(settingSchema),
	release: z.strictObject({ workerAsset: z.string().nullable(), provenance: provenanceSchema })
});

export const findingSchema = z.strictObject({
	severity: z.enum(['blocking', 'warning', 'info']),
	code: z.string().min(1),
	subject: z.string().min(1),
	reason: z.string().min(1),
	provenance: provenanceSchema
});

export type Provenance = z.infer<typeof provenanceSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export type Finding = z.infer<typeof findingSchema>;

const RECIPES: readonly Recipe[] = z
	.array(recipeSchema)
	.parse([drupal, nuxtpress, smoke, mylora, staticSite]);

export function listRecipes(): readonly Recipe[] {
	return RECIPES;
}

export function recipeFor(kind: string): Recipe | undefined {
	return RECIPES.find((recipe) => recipe.id === kind);
}
