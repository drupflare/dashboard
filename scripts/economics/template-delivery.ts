export type Label = 'published' | 'measured' | 'derived' | 'assumption' | 'unknown';

// container rates and the monthly allowance: the Containers pricing page, read through a
// survey summary dated 2026-10-05; reopen the page before quoting
export const RATES = { memGiBSecond: 0.0000025, vcpuSecond: 0.00002, diskGBSecond: 0.00000007 };
export const ALLOWANCE = { gibHours: 25, vcpuMinutes: 375, gbHours: 200 };
export const STANDARD_2 = { vcpu: 1, gib: 6, gb: 12 };

// the worker's non-file body ceiling and the share drangler groups uploads to
export const BODY_CEILING_BYTES = 2 * 1024 * 1024;
export const UPLOAD_SHARE = 0.7;
export const WORKER_BUNDLE_CEILING_BYTES = 64 * 1024 * 1024;
export const INSTALL_BUDGET_PER_CALL = 40;
// Durable Object requests after the included million, per million
export const DO_REQUEST_PER_MILLION = 0.15;

export interface Template {
	name: string;
	packages: number;
	// median wall time of the container build on a Mac under Docker, not on Cloudflare
	buildSeconds: number;
	treeBytes: number;
	codeTarGzBytes: number;
	// rows written by a project delivery in the corpus lane, native install path
	corpusDeliveryRows: number;
}

export const TEMPLATES: readonly Template[] = [
	{
		name: 'Thunder',
		packages: 161,
		buildSeconds: 176.3,
		treeBytes: 142_862_679 + 135_673_225,
		codeTarGzBytes: 76_038_982,
		corpusDeliveryRows: 525
	},
	{
		name: 'GovCMS',
		packages: 274,
		buildSeconds: 48.4,
		treeBytes: 79_166_028 + 170_763_972,
		codeTarGzBytes: 59_775_618,
		corpusDeliveryRows: 38_949
	},
	{
		name: 'farmOS',
		packages: 142,
		buildSeconds: 47.3,
		treeBytes: 150_236_474 + 102_414_405,
		codeTarGzBytes: 66_368_500,
		corpusDeliveryRows: 22_155
	}
];

export function containerCost(seconds: number, shape = STANDARD_2): number {
	return (
		seconds *
		(shape.gib * RATES.memGiBSecond +
			shape.vcpu * RATES.vcpuSecond +
			shape.gb * RATES.diskGBSecond)
	);
}

// builds a month's allowance covers: the scarcest of memory, cpu and disk binds
export function buildsInAllowance(seconds: number, shape = STANDARD_2): number {
	const memory = (ALLOWANCE.gibHours * 3600) / (shape.gib * seconds);
	const cpu = (ALLOWANCE.vcpuMinutes * 60) / (shape.vcpu * seconds);
	const disk = (ALLOWANCE.gbHours * 3600) / (shape.gb * seconds);
	return Math.floor(Math.min(memory, cpu, disk));
}

const uploadBytes = () => BODY_CEILING_BYTES * UPLOAD_SHARE;

export interface ContainerOption {
	costPerBuild: number;
	buildsPerMonthIncluded: number;
	fitsWorkerBundle: boolean;
	modifyCalls: { min: number; max: number };
}

// a container builds the tree and delivers it as /modify revisions; a single Worker bundle
// cannot hold it, so delivery is by upload groups
export function containerOption(template: Template): ContainerOption {
	return {
		costPerBuild: containerCost(template.buildSeconds),
		buildsPerMonthIncluded: buildsInAllowance(template.buildSeconds),
		fitsWorkerBundle: template.treeBytes <= WORKER_BUNDLE_CEILING_BYTES,
		modifyCalls: {
			min: Math.ceil(template.codeTarGzBytes / uploadBytes()),
			max: Math.ceil(template.treeBytes / uploadBytes())
		}
	};
}

export interface InstallOption {
	installCalls: number;
	enableCalls: number;
	objectRequestCost: number;
	rowsWritten: null;
	wallSeconds: null;
}

// one /install per forty packages at best, and /enable for the modules; rows and wall time
// have no reading on a managed site, so they stay null
export function installOption(template: Template): InstallOption {
	const installCalls = Math.ceil(template.packages / INSTALL_BUDGET_PER_CALL);
	const enableCalls = 1;
	return {
		installCalls,
		enableCalls,
		objectRequestCost: ((installCalls + enableCalls) * DO_REQUEST_PER_MILLION) / 1_000_000,
		rowsWritten: null,
		wallSeconds: null
	};
}

export function table(): string {
	const rows = TEMPLATES.map((template) => {
		const container = containerOption(template);
		const install = installOption(template);
		return [
			template.name,
			container.costPerBuild.toFixed(4),
			String(container.buildsPerMonthIncluded),
			container.fitsWorkerBundle ? 'yes' : 'no',
			`${container.modifyCalls.min} to ${container.modifyCalls.max}`,
			`${install.installCalls}+${install.enableCalls}`,
			'unknown'
		].join(' | ');
	});
	return [
		'template | container $ per build | builds in allowance | tree fits worker bundle | /modify calls | /install+/enable calls | /install rows',
		...rows
	].join('\n');
}

if (import.meta.main) console.log(table());
