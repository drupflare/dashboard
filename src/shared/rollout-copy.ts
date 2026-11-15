const METRICS: Record<string, string> = {
	failureRate: 'The share of failed requests',
	resets: 'The number of site restarts',
	memoryTrend: 'Memory growth',
	coldBoots: 'The number of cold starts',
	repairFindings: 'The number of open health findings',
	writeFailures: 'The number of failed writes'
};

const ringWord = (text: string) => text.replace(/\bR([0-5])\b/g, 'ring $1');

// the rollout records reasons as short facts; this turns each one into a sentence for the screen
export function plainReason(reason: string): string {
	const reading = /^no reading for (\w+)$/.exec(reason);
	if (reading) {
		const what = reading[1] as string;
		if (what === 'syntheticHealthy') {
			return 'The test site did not report, so the rollout stopped to be safe.';
		}
		return `${METRICS[what] ?? what} was not reported, so the rollout stopped to be safe.`;
	}
	const high = /^(\w+) is ([\d.]+)$/.exec(reason);
	if (high && METRICS[high[1] as string]) {
		return `${METRICS[high[1] as string]} is ${high[2]}, which is over the limit.`;
	}
	if (reason === 'the synthetic site is broken') return 'The test site stopped answering.';
	if (reason === 'an admin stopped the rollout') return 'An admin stopped the rollout.';
	const missed = /^(\d+) of (\d+) sites in (R[0-5]) did not take the release$/.exec(reason);
	if (missed) {
		return `${missed[1]} of ${missed[2]} sites in ${ringWord(missed[3] as string)} did not take the release.`;
	}
	const late = /^the sites in (R[0-5]) did not report in time$/.exec(reason);
	if (late) return `The sites in ${ringWord(late[1] as string)} did not report in time.`;
	return `${ringWord(reason).replace(/^./, (first) => first.toUpperCase())}.`;
}

// milliseconds as days, hours and minutes, largest unit first
export function plainDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return 'under a minute';
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const rest = minutes % 60;
	const parts = [
		days > 0 ? `${days} ${days === 1 ? 'day' : 'days'}` : null,
		hours > 0 ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : null,
		days === 0 && rest > 0 ? `${rest} ${rest === 1 ? 'minute' : 'minutes'}` : null
	].filter((part) => part !== null);
	return parts.join(' ');
}
