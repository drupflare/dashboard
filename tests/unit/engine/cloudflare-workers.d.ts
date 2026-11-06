declare module 'cloudflare:workers' {
	export class DurableObject<Env = unknown> {
		ctx: {
			storage: {
				kv: {
					get<T = unknown>(key: string): T | undefined;
					put(key: string, value: unknown): void;
				};
			};
			id: { name?: string };
		};
		env: Env;
		constructor(ctx: unknown, env: Env);
	}
}
