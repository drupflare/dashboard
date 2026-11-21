import { defineConfig } from 'vitest/config';
import base from './vitest.node.config';

export default defineConfig({
	...base,
	test: {
		...base.test,
		include: ['tests/integration/**/*.spec.ts']
	}
});
