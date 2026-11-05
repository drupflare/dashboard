import { z } from 'zod';

export const TEMPLATE_CLASSES = ['first', 'second', 'third'] as const;

const templateSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	class: z.enum(TEMPLATE_CLASSES).nullable(),
	enabled: z.boolean(),
	comingSoon: z.string().nullable(),
	planGate: z.enum(['free', 'paid-managed-or-self-managed']).nullable(),
	source: z.string().min(1)
});

type Template = z.infer<typeof templateSchema>;

export const TEMPLATES: readonly Template[] = z.array(templateSchema).parse([
	{
		id: 'drupal',
		name: 'Drupal',
		class: 'first',
		enabled: true,
		comingSoon: null,
		planGate: 'free',
		source: 'roadmap:451 class; plan:448 list; plan:27 free'
	},
	{
		id: 'static-site',
		name: 'Static Site',
		class: null,
		enabled: true,
		comingSoon: null,
		planGate: 'free',
		source: 'plan:448 list; plan:27 free; roadmap gives no class'
	},
	{
		id: 'nuxtpress',
		name: 'Nuxtpress',
		class: 'second',
		enabled: true,
		comingSoon: null,
		planGate: 'free',
		source: 'roadmap:451 class; plan:448 list; plan:27 free'
	},
	{
		id: 'smoke',
		name: 'Smoke',
		class: 'third',
		enabled: true,
		comingSoon: null,
		planGate: 'free',
		source: 'roadmap:451 class; plan:448 list; plan:27 free'
	},
	{
		id: 'mylora',
		name: 'MyLoRA',
		class: 'third',
		enabled: true,
		comingSoon: null,
		planGate: 'free',
		source: 'roadmap:451 class; plan:448 list; plan:27 free'
	},
	{
		id: 'wordpress',
		name: 'WordPress',
		class: 'second',
		enabled: false,
		comingSoon: 'Coming Soon',
		planGate: null,
		source: 'roadmap:451 class; plan:37 greyed out'
	},
	{
		id: 'joomla',
		name: 'Joomla',
		class: 'second',
		enabled: false,
		comingSoon: 'Coming Soon',
		planGate: null,
		source: 'roadmap:451 class; roadmap:388; plan:37 greyed out'
	},
	{
		id: 'gmux',
		name: 'gmux',
		class: null,
		enabled: false,
		comingSoon: 'Coming Soon',
		planGate: null,
		source: 'plan:37 greyed out; roadmap gives no class'
	},
	{
		id: 'bring-your-own',
		name: 'Bring Your Own',
		class: null,
		enabled: true,
		comingSoon: null,
		planGate: 'paid-managed-or-self-managed',
		source: 'plan:448 list; plan:27 arbitrary templates paid only'
	},
	{
		id: 'import-from-server',
		name: 'Import From a Server',
		class: null,
		enabled: true,
		comingSoon: null,
		planGate: null,
		source: 'plan:448 list; plan states no gate'
	}
]);

// approved workers for the e2e lane, plan:944
export const E2E_APPROVED_TEMPLATE_IDS: readonly string[] = [
	'drupal',
	'static-site',
	'nuxtpress',
	'smoke',
	'mylora'
];
