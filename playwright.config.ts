import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 8787);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? undefined : 1,
	reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
	outputDir: 'test-results',
	use: {
		baseURL,
		trace: 'on-first-retry',
		launchOptions: process.env.E2E_CHROMIUM
			? { executablePath: process.env.E2E_CHROMIUM, args: ['--no-sandbox'] }
			: {}
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		},
		{
			name: 'mobile-chromium',
			use: { ...devices['Pixel 7'] }
		},
		{
			name: 'firefox',
			testMatch: /spool\.spec\.ts/,
			use: { ...devices['Desktop Firefox'] }
		}
	],
	webServer: {
		command: `npx wrangler dev --config .output/server/wrangler.json --ip 127.0.0.1 --port ${port}`,
		url: baseURL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000
	}
});
