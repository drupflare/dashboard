// hand-copied from drangler HEAD: src/host/exec.ts (CommandResult) and src/migrate/transport.ts (Transport)
// only the members survey.ts uses; the sync script does not write this file

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface Transport {
	exec(command: string): Promise<CommandResult>;
}
