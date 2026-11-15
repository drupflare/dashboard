export const BUNDLE_MAGIC: string;
export const BUNDLE_VERSION: number;
export const EXIT_BAD_SPEC: number;
export const EXIT_STEP_FAILED: number;

export interface TemplateSpec {
	id: string;
	repo: string;
	sha: string;
	profile: string;
	mode: 'template' | 'profile';
	template: string;
	package: string;
	extra: string[];
	auditOff: boolean;
	patchTolerant: boolean;
	enablePatching: boolean;
}

export interface Step {
	file: string;
	args: string[];
	cwd?: string;
}

export type RunCommand = (
	file: string,
	args: string[],
	options: {
		cwd: string;
		env: Record<string, string>;
		log(line: string): void;
		signal: AbortSignal;
	}
) => Promise<number | 'timeout' | 'killed'>;

export function parseSpec(text: string): TemplateSpec;
export function advisoriesOf(text: string): { id: string; package: string }[] | null;
export function patchFailuresOf(lines: string[]): { package: string; patch: string }[];
export function countRows(sql: string): number;
export function encodeBundle(
	manifest: Record<string, unknown>,
	sections: { name: string; bytes: Uint8Array }[]
): Buffer;
export function resolveSteps(
	spec: TemplateSpec,
	paths: { dir: string; clone: string; site: string }
): Step[];
export function useProfileRepositories(clone: string, site: string): Promise<void>;
export function templateBuild(
	job: {
		dir: string;
		input: string;
		output: string;
		log(line: string): void;
		signal: AbortSignal;
	},
	deps: { run: RunCommand; env(dir: string): Record<string, string> }
): Promise<number | 'timeout' | 'killed'>;
