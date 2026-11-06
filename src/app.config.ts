export default defineAppConfig({
	name: 'Drupflare',
	description: 'Drupal, Minus the Server',
	ui: {
		colors: {
			primary: 'brand',
			success: 'leaf'
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
