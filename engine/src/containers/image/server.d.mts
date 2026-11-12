import type { Server } from 'node:http';

export const KINDS: string[];
export const EXIT_HEADER: string;
export const EXIT_NOT_BUILT: number;
export const EXIT_OUTPUT_TOO_LARGE: number;

export interface JobContext {
	dir: string;
	input: string;
	output: string;
	log(line: string): void;
	signal: AbortSignal;
}

export type JobResult = number | 'timeout' | 'killed';
export type JobRunnerFn = (job: JobContext) => Promise<JobResult>;

export interface RunnerOptions {
	runners?: Record<string, JobRunnerFn>;
	root?: string;
	inputLimit?: number;
	outputLimit?: number;
	wallMs?: number;
	log?(line: string): void;
}

export const RUNNERS: Record<string, JobRunnerFn>;
export function childEnv(dir: string): Record<string, string>;
export function composerSteps(project: string, input: string, output: string): [string, string[]][];
export function createRunner(options?: RunnerOptions): Server;
