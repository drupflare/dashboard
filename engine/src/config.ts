import type { EngineConfig } from './ports';
import { PermanentError } from './step';

export class ConfigError extends PermanentError {
	constructor(name: string) {
		super('missing_config', `${name} must be set to a positive whole number`);
	}
}

export const CONFIG_VARS = [
	'LEASE_TTL_MS',
	'ASSET_CHUNK_BYTES',
	'LIMIT_MODULE_BYTES',
	'LIMIT_TOTAL_BYTES',
	'LIMIT_ASSET_BYTES',
	'LIMIT_ASSETS'
] as const;

// no default for any of these: a value the deploy did not state is a value nobody checked
export function readConfig(
	env: Readonly<Record<string, unknown>>,
	assetSessionMs: number
): EngineConfig {
	const read = (name: (typeof CONFIG_VARS)[number]): number => {
		const raw = env[name];
		const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
		if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigError(name);
		return value;
	};
	return {
		leaseTtlMs: read('LEASE_TTL_MS'),
		chunkBytes: read('ASSET_CHUNK_BYTES'),
		assetSessionMs,
		limits: {
			maxModuleBytes: read('LIMIT_MODULE_BYTES'),
			maxTotalBytes: read('LIMIT_TOTAL_BYTES'),
			maxAssetBytes: read('LIMIT_ASSET_BYTES'),
			maxAssets: read('LIMIT_ASSETS')
		}
	};
}
