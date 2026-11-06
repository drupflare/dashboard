// the synchronous key-value surface of a SQLite-backed Durable Object (ctx.storage.kv)
export type SyncKv = {
	get<T = unknown>(key: string): T | undefined;
	put(key: string, value: unknown): void;
};
