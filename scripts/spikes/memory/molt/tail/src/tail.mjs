export default {
	tail(events) {
		for (const e of events) {
			console.log(
				JSON.stringify({
					script: e.scriptName,
					ts: e.eventTimestamp,
					outcome: e.outcome,
					cpuTime: e.cpuTime,
					wallTime: e.wallTime,
					event: Object.keys(e.event ?? {})
				})
			);
		}
	}
};
