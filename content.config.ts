import { defineCollection, defineContentConfig, z } from '@nuxt/content';
import { fileURLToPath } from 'node:url';

const audiences = [
	'solo-beginner',
	'developer',
	'agency',
	'nonprofit',
	'department-owner',
	'central-it',
	'security-reviewer',
	'self-hosting-operator'
] as const;

export default defineContentConfig({
	collections: {
		docs: defineCollection({
			type: 'page',
			source: {
				cwd: fileURLToPath(new URL('./docs', import.meta.url)),
				include: '**/*.md'
			},
			schema: z.object({
				title: z.string(),
				description: z.string(),
				audience: z.array(z.enum(audiences)),
				type: z.enum(['written', 'generated', 'screenshot']),
				draft: z.boolean()
			})
		})
	}
});
