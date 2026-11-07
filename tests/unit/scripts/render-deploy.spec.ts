import { describe, expect, it } from 'vitest';
import {
	merge,
	missingIds,
	readConfig,
	render,
	resolve,
	type Config
} from '../../../scripts/render-deploy';

describe('merge', () => {
	it('merges objects key by key and replaces arrays whole', () => {
		expect(
			merge(
				{ vars: { A: '1', B: '2' }, kv_namespaces: [{ binding: 'KV' }, { binding: 'X' }] },
				{ vars: { B: '3' }, kv_namespaces: [{ binding: 'KV', id: 'a' }] }
			)
		).toEqual({ vars: { A: '1', B: '3' }, kv_namespaces: [{ binding: 'KV', id: 'a' }] });
	});
});

describe('resolve', () => {
	const base: Config = { name: 'x', vars: { A: '1' }, env: { stage: { name: 'x-stage' } } };

	it('lets the stage block replace the top level for staging', () => {
		expect(resolve(base, 'engine', 'staging')).toEqual({ name: 'x-stage', vars: { A: '1' } });
	});

	it('uses the top level for production and drops the env blocks', () => {
		expect(resolve(base, 'engine', 'production')).toEqual({ name: 'x', vars: { A: '1' } });
	});

	it('refuses a staging render of a unit with no stage block', () => {
		expect(() => resolve({ name: 'x' }, 'dispatch', 'staging')).toThrow('no stage block');
	});
});

describe('missingIds', () => {
	it('names each D1 and KV binding that has no id', () => {
		expect(
			missingIds({
				d1_databases: [{ binding: 'DB' }],
				kv_namespaces: [{ binding: 'KV', id: 'a' }, { binding: 'CACHE' }]
			})
		).toEqual(['d1 DB', 'kv CACHE']);
	});

	it('accepts a config with no bindings of either kind', () => {
		expect(missingIds({})).toEqual([]);
	});
});

describe('the committed deploy files', () => {
	const built = (path: string): Config =>
		path === '.output/server/wrangler.json'
			? {
					name: 'drupflare-dashboard',
					d1_databases: [{ binding: 'DB' }],
					kv_namespaces: [
						{ binding: 'KV' },
						{ binding: 'CACHE' },
						{ binding: 'HOSTS_KV' }
					]
				}
			: readConfig(path);

	it('renders every staging unit with an id on every D1 and KV binding', () => {
		for (const unit of ['dashboard', 'engine', 'dispatch'] as const) {
			expect(() => render(unit, 'staging', built)).not.toThrow();
		}
	});

	it('puts the staging dashboard on its own hostname', () => {
		const config = render('dashboard', 'staging', built) as Config & {
			routes: { pattern: string }[];
			vars: Record<string, string>;
		};
		expect(config.routes).toEqual([
			{ pattern: 'staging-app.drupflare.com', custom_domain: true }
		]);
		expect(config.vars.NUXT_BASE_URL).toBe('https://staging-app.drupflare.com');
	});

	it('renders every production unit with its own resources, none shared with staging', () => {
		for (const unit of ['dashboard', 'engine', 'dispatch'] as const) {
			const production = JSON.stringify(render(unit, 'production', built));
			const staging = JSON.stringify(render(unit, 'staging', built));
			// both environments live in one account, so its id is the one id they share
			const ids = (staging.match(/[0-9a-f]{32}|[0-9a-f-]{36}/g) ?? []).filter(
				(id) => id !== '2bba2ae752a5bb611580fdccbce6d200'
			);
			for (const id of ids) {
				expect(production, `${unit} ${id}`).not.toContain(id);
			}
		}
	});

	it('names no id for a binding the overlay forgot', () => {
		const forgot = (path: string): Config =>
			path === 'deploy/engine.production.json'
				? { workers_dev: false }
				: path === 'engine/wrangler.jsonc'
					? { name: 'e', d1_databases: [{ binding: 'DB' }] }
					: built(path);
		expect(() => render('engine', 'production', forgot)).toThrow('has no id for: d1 DB');
	});

	it('keeps the two dashboards on different hostnames', () => {
		const route = (environment: 'staging' | 'production') =>
			(
				readConfig(`deploy/dashboard.${environment}.json`) as Config & {
					routes: { pattern: string }[];
				}
			).routes[0]!.pattern;
		expect(route('staging')).not.toBe(route('production'));
		expect(route('production')).toBe('app.drupflare.com');
	});
});
