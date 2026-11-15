import type {
	InstallVerdict,
	ModuleWorker,
	ThemeDefaultAnswer,
	UninstallAnswer
} from '../../../engine/src/ports';

interface Held {
	present: boolean;
	enabled: boolean;
}

// an in-memory site that keeps what was installed and enabled, so a workflow can read it back
export function fakeModules(held: Record<string, Held> = {}) {
	const modules = new Map(Object.entries(held));
	const calls = {
		installable: [] as string[],
		reads: [] as string[],
		installs: [] as string[],
		enables: [] as string[],
		uninstalls: [] as { project: string; dryRun: boolean }[],
		themes: [] as { project: string; target: string; dryRun: boolean }[],
		bearers: new Set<string>()
	};
	const script = {
		verdict: { verdict: 'installable', conflicts: [] } as InstallVerdict,
		// what an install leaves on the site; false models a refusal that writes nothing
		installOk: true,
		enableOk: true,
		uninstall: {
			kind: 'plan',
			enabledModules: [] as string[],
			dependents: [] as string[],
			wouldDelete: [] as string[]
		} as UninstallAnswer,
		themesAvailable: true,
		themes: { default: null as string | null, admin: null as string | null },
		beforeInstall: undefined as (() => Promise<void>) | undefined
	};
	const get = (project: string): Held =>
		modules.get(project) ?? { present: false, enabled: false };

	const worker: ModuleWorker = {
		async installable(_host, name, auth) {
			calls.bearers.add(auth.bearer);
			calls.installable.push(name);
			return script.verdict;
		},
		async read(_host, project, auth) {
			calls.bearers.add(auth.bearer);
			calls.reads.push(project);
			return { ...get(project) };
		},
		async install(_host, name, auth) {
			calls.bearers.add(auth.bearer);
			await script.beforeInstall?.();
			calls.installs.push(name);
			if (!script.installOk) return { ok: false };
			modules.set(name.slice(name.indexOf('/') + 1), { present: true, enabled: false });
			return { ok: true };
		},
		async enable(_host, project, auth) {
			calls.bearers.add(auth.bearer);
			calls.enables.push(project);
			if (!script.enableOk) return { ok: false };
			modules.set(project, { present: true, enabled: true });
			return { ok: true };
		},
		async uninstall(_host, project, options, auth) {
			calls.bearers.add(auth.bearer);
			calls.uninstalls.push({ project, dryRun: options.dryRun });
			if (script.uninstall.kind !== 'plan') return script.uninstall;
			if (options.dryRun) return script.uninstall;
			modules.set(project, { present: true, enabled: false });
			return { kind: 'removed' };
		},
		async setDefaultTheme(_host, change, options, auth): Promise<ThemeDefaultAnswer> {
			calls.bearers.add(auth.bearer);
			calls.themes.push({ ...change, dryRun: options.dryRun });
			if (!script.themesAvailable) return { kind: 'not_available' };
			if (!options.dryRun) script.themes[change.target] = change.project;
			return { kind: 'set', ...script.themes };
		}
	};
	return { worker, calls, script, modules };
}
