import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Elapsed time while the agent works, and the last turn's time in the footer. */
export default function (pi: ExtensionAPI) {
	let started: number | undefined;
	let ticker: NodeJS.Timeout | undefined;

	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.hasUI || started !== undefined) return;
		started = Date.now();
		const tick = () => ctx.ui.setWorkingMessage(`Working · ${formatDuration(Date.now() - (started ?? Date.now()))}`);
		tick();
		ticker = setInterval(tick, 1000);
	});

	pi.on("agent_settled", (_event, ctx) => {
		clearInterval(ticker);
		ticker = undefined;
		if (started === undefined || !ctx.hasUI) return;
		ctx.ui.setWorkingMessage();
		ctx.ui.setStatus("turn-time", `turn ${formatDuration(Date.now() - started)}`);
		started = undefined;
	});

	pi.on("session_shutdown", () => clearInterval(ticker));
}
