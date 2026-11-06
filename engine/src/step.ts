export interface StepRunner {
	do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

// a step that ran out of retries; anything else escaping a step is an interruption, not a failure
export class StepFailed extends Error {
	constructor(
		readonly step: string,
		readonly reason: unknown
	) {
		super(`step ${step} failed: ${reason instanceof Error ? reason.message : String(reason)}`);
		this.name = 'StepFailed';
	}
}

// a refusal that retrying cannot fix
export class PermanentError extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = new.target.name;
	}
}

export function messageOf(error: unknown): string {
	if (error instanceof PermanentError) return `${error.code}: ${error.message}`;
	return error instanceof Error ? error.message : String(error);
}
