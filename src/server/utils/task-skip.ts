export const NOT_INSTALLED = 'the services are not installed in this isolate yet';

export function notInstalled(task: string): { result: { skipped: string } } {
	console.error(`task ${task}: the services are not installed after the boot hook ran`);
	return { result: { skipped: NOT_INSTALLED } };
}
