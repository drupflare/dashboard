import type { Operation } from '@contracts/operations';
import type { SiteKind } from '@contracts/sites';
import { toApiClientError } from '~/composables/useApi';
import { isValidName, suffixOwner, suggest } from '~/shared/names';
import { useSessionStore } from '~/stores/session';
import type { SiteSummary } from '~/stores/sites';

export type OnboardingStep = 1 | 2;

export const STEP_TITLES: Record<OnboardingStep, string> = {
	1: 'Template',
	2: 'Name and Create'
};

const DEFAULT_TEMPLATE = 'drupal';
export const HOST_SUFFIX = 'drupflare.app';

const STORAGE_KEY = 'drupflare.onboarding';

// the bring-your-own template creates a custom site; static-site has no kind in the create contract
const KIND_BY_TEMPLATE: Partial<Record<string, SiteKind>> = {
	drupal: 'drupal',
	nuxtpress: 'nuxtpress',
	smoke: 'smoke',
	mylora: 'mylora',
	'bring-your-own': 'custom'
};

// the import card leads to its own page instead of creating a site kind
export const IMPORT_TEMPLATE = 'import';

export function kindFor(templateId: string): SiteKind | null {
	return KIND_BY_TEMPLATE[templateId] ?? null;
}

export function nameProblem(name: string): string | null {
	if (!isValidName(name)) {
		return 'Use 3 to 63 lowercase letters, numbers and single hyphens. Start and end with a letter or number.';
	}
	const owner = suffixOwner(name);
	if (owner === 'nobody') return 'This name is reserved.';
	if (owner === 'paid-managed') return 'Names with this ending are for paid managed sites.';
	return null;
}

export function adminUrlFor(site: Pick<SiteSummary, 'kind' | 'primaryHostname'>): string | null {
	if (site.kind !== 'drupal' || site.primaryHostname === null) return null;
	return `https://${site.primaryHostname}/user/login`;
}

export interface OnboardingDraft {
	step: OnboardingStep;
	template: string;
	name: string;
	seed: string;
	idempotencyKey: string;
}

function newDraft(): OnboardingDraft {
	const seed = crypto.randomUUID();
	return {
		step: 1,
		template: DEFAULT_TEMPLATE,
		name: suggest(seed),
		seed,
		idempotencyKey: crypto.randomUUID()
	};
}

function isStep(value: unknown): value is OnboardingStep {
	return value === 1 || value === 2;
}

function loadDraft(): OnboardingDraft {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (raw) {
			const saved = JSON.parse(raw) as Partial<OnboardingDraft>;
			if (
				isStep(saved.step) &&
				typeof saved.template === 'string' &&
				typeof saved.name === 'string' &&
				typeof saved.seed === 'string' &&
				typeof saved.idempotencyKey === 'string'
			) {
				return {
					step: saved.step,
					template: saved.template,
					name: saved.name,
					seed: saved.seed,
					idempotencyKey: saved.idempotencyKey
				};
			}
		}
	} catch {
		// unreadable or blocked storage starts a fresh draft
	}
	return newDraft();
}

type Fetcher = (
	url: string,
	options: {
		method: 'POST';
		headers: Record<string, string>;
		body: { kind: SiteKind; name: string };
	}
) => Promise<Operation>;

export function useOnboarding() {
	const draft = useState<OnboardingDraft>('onboarding-draft', loadDraft);
	let inflight: Promise<Operation> | null = null;

	watch(
		draft,
		(value) => {
			try {
				sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
			} catch {
				// the draft stays in memory when storage is blocked
			}
		},
		{ deep: true, flush: 'sync' }
	);

	function go(step: OnboardingStep): void {
		draft.value.step = step;
	}

	function reset(): void {
		draft.value = newDraft();
	}

	// one request per draft: a second call while the first is in flight returns the same promise
	function create(orgId: string, kind: SiteKind): Promise<Operation> {
		inflight ??= submit(orgId, kind).finally(() => {
			inflight = null;
		});
		return inflight;
	}

	async function submit(orgId: string, kind: SiteKind): Promise<Operation> {
		const { idempotencyKey, name } = draft.value;
		// useApi has no header argument; the create call needs Idempotency-Key
		const fetcher = $fetch as unknown as Fetcher;
		try {
			const operation = await fetcher(`/api/v1/orgs/${encodeURIComponent(orgId)}/sites`, {
				method: 'POST',
				headers: { 'Idempotency-Key': idempotencyKey },
				body: { kind, name }
			});
			reset();
			return operation;
		} catch (error) {
			const apiError = toApiClientError(error);
			if (apiError.status === 401) useSessionStore().clear();
			throw apiError;
		}
	}

	return { draft, go, reset, create };
}
