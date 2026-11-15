<script setup lang="ts">
import type { Operation } from '@contracts/operations';
import { INSTALL_STEPS, type ModuleCheck, type ModuleState } from '~/shared/modules';
import {
	copyFor,
	failedStepError,
	failedStepId,
	failureReason,
	stepLabel
} from '~/shared/operation-copy';

const props = defineProps<{
	name: string;
	state: ModuleState;
	shipping: boolean;
	check: ModuleCheck | null;
	checking: boolean;
	install: Operation | null;
	enable: Operation | null;
	starting: 'install' | 'enable' | null;
	error: string | null;
}>();
const emit = defineEmits<{ run: []; install: [confirm: boolean]; enable: [] }>();

const confirmed = ref(false);

const ENDED = ['succeeded', 'failed', 'cancelled', 'rolled-back'];
const running = (operation: Operation | null) =>
	operation !== null && !ENDED.includes(operation.status);

const installBusy = computed(() => props.starting === 'install' || running(props.install));
const enableBusy = computed(() => props.starting === 'enable' || running(props.enable));
const needsConfirm = computed(() => props.state === 'untested');
const canInstall = computed(
	() =>
		props.check?.ok === true &&
		!props.shipping &&
		(!needsConfirm.value || confirmed.value) &&
		!installBusy.value
);

interface Progress {
	icon: string;
	text: string;
	tone: string;
	spin: boolean;
	restorePoint: boolean;
}

function progress(operation: Operation | null): Progress | null {
	if (operation === null) return null;
	const restorePoint = operation.steps.some(
		(step) => step.id === 'restore-point-record' && step.state === 'succeeded'
	);
	if (operation.status === 'succeeded') {
		return {
			icon: 'i-lucide-circle-check',
			text: copyFor(operation.type).success,
			tone: 'text-success',
			spin: false,
			restorePoint
		};
	}
	if (ENDED.includes(operation.status)) {
		const reason = failureReason({
			type: operation.type,
			status: operation.status,
			failedStep: failedStepId(operation.steps),
			failedError: failedStepError(operation.steps)
		});
		return {
			icon: 'i-lucide-circle-x',
			text: reason ?? copyFor(operation.type).failure,
			tone: 'text-error',
			spin: false,
			restorePoint
		};
	}
	const current = operation.steps.find((step) => step.state === 'running');
	return {
		icon: 'i-lucide-loader-circle',
		text: current === undefined ? 'Starting.' : `${stepLabel(operation.type, current.id)}.`,
		tone: 'text-muted',
		spin: true,
		restorePoint
	};
}

const installProgress = computed(() => progress(props.install));
const enableProgress = computed(() => progress(props.enable));
</script>

<template>
	<section
		class="flex flex-col gap-4 rounded-lg border border-default p-4"
		aria-labelledby="module-install-title"
	>
		<h3
			id="module-install-title"
			class="font-medium"
		>
			Install {{ name }}
		</h3>
		<ol class="flex flex-col gap-4">
			<li
				v-for="step in INSTALL_STEPS"
				:key="step.id"
				class="flex flex-col gap-2 sm:flex-row sm:items-start"
			>
				<div class="flex-1">
					<p class="font-medium">{{ step.title }}</p>

					<template v-if="step.id === 'check'">
						<p
							v-if="check"
							class="text-sm"
							:class="check.ok ? 'text-success' : 'text-error'"
						>
							<UIcon
								:name="check.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
								class="mr-1 inline size-4"
								aria-hidden="true"
							/>
							{{ check.message }}
						</p>
						<ul
							v-if="check && check.conflicts.length > 0"
							class="mt-1 list-inside list-disc text-sm text-muted"
						>
							<li
								v-for="conflict in check.conflicts"
								:key="conflict.requires"
							>
								{{ conflict.requires }} needs {{ conflict.constraint }}
								<span v-if="conflict.installed === null"
									>, which the site does not have.</span
								>
								<span v-else>, and the site has {{ conflict.installed }}.</span>
							</li>
						</ul>
					</template>

					<template v-else-if="step.id === 'install'">
						<p
							v-if="!installProgress && shipping"
							class="text-sm text-muted"
						>
							This module is included with every site, so there is nothing to install.
						</p>
						<p
							v-else-if="!installProgress"
							class="text-sm text-muted"
						>
							A restore point of the site is saved first, so the site can go back.
						</p>
						<UCheckbox
							v-if="needsConfirm && !shipping && !installProgress"
							v-model="confirmed"
							label="This module has never been run on a site. Install it anyway."
						/>
						<p
							v-if="installProgress"
							class="text-sm"
							:class="installProgress.tone"
							role="status"
						>
							<UIcon
								:name="installProgress.icon"
								class="mr-1 inline size-4"
								:class="{ 'animate-spin': installProgress.spin }"
								aria-hidden="true"
							/>
							{{ installProgress.text }}
						</p>
						<p
							v-if="installProgress?.restorePoint"
							class="text-sm text-muted"
						>
							A restore point of the site was saved before the change.
						</p>
					</template>

					<template v-else>
						<p
							v-if="!enableProgress"
							class="text-sm text-muted"
						>
							Turns the module on. Installing does not turn it on.
						</p>
						<p
							v-if="enableProgress"
							class="text-sm"
							:class="enableProgress.tone"
							role="status"
						>
							<UIcon
								:name="enableProgress.icon"
								class="mr-1 inline size-4"
								:class="{ 'animate-spin': enableProgress.spin }"
								aria-hidden="true"
							/>
							{{ enableProgress.text }}
						</p>
						<p
							v-if="enableProgress?.restorePoint"
							class="text-sm text-muted"
						>
							A restore point of the site was saved before the change.
						</p>
					</template>
				</div>

				<UButton
					v-if="step.id === 'check'"
					label="Run Check"
					variant="outline"
					:loading="checking"
					@click="emit('run')"
				/>
				<UButton
					v-else-if="step.id === 'install'"
					label="Install"
					variant="outline"
					:loading="installBusy"
					:disabled="!canInstall"
					@click="emit('install', confirmed)"
				/>
				<UButton
					v-else
					label="Enable"
					variant="outline"
					:loading="enableBusy"
					:disabled="enableBusy"
					@click="emit('enable')"
				/>
			</li>
		</ol>
		<p
			v-if="error"
			role="alert"
			class="text-sm text-error"
		>
			{{ error }}
		</p>
	</section>
</template>
