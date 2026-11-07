export default defineAppConfig({
	name: 'Drupflare',
	description: 'Drupal, Minus the Server',
	ui: {
		colors: {
			primary: 'brand',
			success: 'leaf',
			neutral: 'ink'
		},
		button: {
			compoundVariants: [
				{
					color: 'primary',
					variant: 'solid',
					class: 'text-ink'
				}
			]
		}
	}
});
