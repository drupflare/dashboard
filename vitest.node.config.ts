import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			'@contracts': path('./contracts/src'),
			'#shared': path('./src/shared'),
			'~~': path('./'),
			'~': path('./src'),
			'@': path('./src')
		}
	},
	test: {
		environment: 'node',
		include: [
			'tests/unit/{contracts,domain,scripts,security,server,shared}/**/*.spec.ts',
			'tests/bindings/**/*.spec.ts'
		],
		globals: true,
		testTimeout: 30_000,
		hookTimeout: 60_000
	}
});
