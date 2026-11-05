import { describe, expect, it } from 'vitest';
import {
	ACCESS_PRESET_IDS,
	ACCESS_PRESETS,
	INVITEE_LIMITS
} from '../../../src/shared/access-presets';

function preset(id: string) {
	const found = ACCESS_PRESETS.find((item) => item.id === id);
	if (!found) throw new Error(`no preset ${id}`);
	return found;
}

describe('access presets', () => {
	it('lists every preset once, in the plan order', () => {
		expect(ACCESS_PRESET_IDS).toEqual([
			'members',
			'grants',
			'email-invite',
			'github-user',
			'gitlab-user',
			'github-org',
			'gitlab-group',
			'sso',
			'password',
			'review-link',
			'public'
		]);
		expect(ACCESS_PRESETS.map((item) => item.id)).toEqual([...ACCESS_PRESET_IDS]);
	});

	it('unlocks email invites on the free plan and review links on Agency', () => {
		expect(preset('email-invite').unlockedBy).toBe('managed-free');
		expect(preset('review-link').unlockedBy).toBe('managed-agency');
		expect(preset('github-user').unlockedBy).toBe('managed-site');
	});

	it('leaves the tier null where the plan does not state one', () => {
		for (const id of ['members', 'grants', 'gitlab-user', 'github-org', 'gitlab-group']) {
			expect(preset(id).unlockedBy).toBe(null);
		}
		expect(preset('public').unlockedBy).toBe(null);
	});

	it('labels every invitee count as an assumption from the plan', () => {
		expect(INVITEE_LIMITS['managed-free']).toEqual({
			value: 5,
			label: 'assumption',
			source: 'plan:428; roadmap:270'
		});
		expect(INVITEE_LIMITS['managed-site'].value).toBe(25);
		expect(INVITEE_LIMITS['managed-studio'].value).toBe(100);
		expect(INVITEE_LIMITS['managed-agency'].value).toBe(500);
		for (const limit of Object.values(INVITEE_LIMITS)) {
			expect(limit.label).toBe('assumption');
		}
	});
});
