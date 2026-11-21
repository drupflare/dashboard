import { describe, expect, it } from 'vitest';
import {
	analyse,
	fleschKincaid,
	jargonHits,
	sentencesOver,
	splitArgs,
	syllables
} from '../../../scripts/docs-readability';

describe('docs readability arithmetic', () => {
	it('computes the Flesch-Kincaid grade from word, sentence and syllable counts', () => {
		// 0.39 * 20 + 11.8 * 1.5 - 15.59
		expect(fleschKincaid(100, 5, 150)).toBeCloseTo(9.91, 2);
	});

	it('has no grade for an empty page', () => {
		expect(fleschKincaid(0, 0, 0)).toBeNull();
	});

	it('counts syllables with the vowel-group heuristic', () => {
		expect(syllables('table')).toBe(2);
		expect(syllables('cats')).toBe(1);
		expect(syllables('make')).toBe(1);
		expect(syllables('hello')).toBe(2);
		expect(syllables('education')).toBe(4);
		expect(syllables('Verified')).toBe(3);
		expect(syllables('the')).toBe(1);
	});

	it('strips frontmatter, fenced code and tables before counting', () => {
		const page = [
			'---',
			'title: X',
			'---',
			'',
			'# Heading here',
			'',
			'Use the `dashboard`. See [the plan](/docs/x).',
			'',
			'```',
			'not counted here',
			'```',
			'',
			'| a | b |',
			'| - | - |',
			'| c | d |',
			''
		].join('\n');
		const stats = analyse(page);
		expect(stats.words).toBe(8);
		expect(stats.sentences).toBe(3);
		expect(stats.longest).toBe(3);
	});

	it('reports the grade that its own counts give', () => {
		const stats = analyse('Short one. This sentence has seven words in it now.');
		expect(stats.longest).toBe(8);
		expect(stats.grade).toBeCloseTo(
			fleschKincaid(stats.words, stats.sentences, stats.syllables) ?? NaN,
			6
		);
	});

	it('counts jargon terms as whole words with a plural s', () => {
		expect(jargonHits('Each lease has an epoch and two leases. Rings and the ring.')).toBe(5);
		expect(jargonHits('Leasehold and rhythm do not count.')).toBe(0);
	});

	it('keeps every path when no --over flag is given', () => {
		expect(splitArgs(['docs/start', 'docs/index.md'])).toEqual({
			limit: null,
			args: ['docs/start', 'docs/index.md']
		});
	});

	it('takes the --over limit out of the path list', () => {
		expect(splitArgs(['--over', '30', 'docs/start'])).toEqual({
			limit: 30,
			args: ['docs/start']
		});
	});

	it('lists sentences over a word limit', () => {
		expect(sentencesOver('Short one. This sentence has seven words in it now.', 7)).toEqual([
			'This sentence has seven words in it now.'
		]);
	});
});
