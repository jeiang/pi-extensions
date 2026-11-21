import assert from "node:assert/strict";
import { test } from "node:test";
import { chartLines, parseAnthropic, parseCodex } from "../extensions/usage/index.ts";

test("parses Anthropic limits, marking model-scoped ones", () => {
	const windows = parseAnthropic({
		five_hour: { utilization: 14 },
		limits: [
			{ kind: "session", percent: 14, resets_at: "2026-11-20T03:30:00.003162+00:00", scope: null },
			{ kind: "weekly_all", percent: 47, resets_at: "2026-11-21T15:00:00+00:00", scope: null },
			{ kind: "weekly_scoped", percent: 35, resets_at: "bad", scope: { model: { id: null, display_name: "Fable" } } },
			{ kind: "session", percent: "14" },
			null,
		],
	});
	assert.deepEqual(windows, [
		{ label: "5h", percent: 14, resetsAt: Date.parse("2026-11-20T03:30:00.003162+00:00") },
		{ label: "7d", percent: 47, resetsAt: Date.parse("2026-11-21T15:00:00+00:00") },
		{ label: "7d Fable", percent: 35, scoped: true },
	]);
});

test("parses Codex primary and secondary windows", () => {
	const windows = parseCodex({
		rate_limit: {
			primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1795155627 },
			secondary_window: { used_percent: 100, limit_window_seconds: 604800 },
		},
	});
	assert.deepEqual(windows, [
		{ label: "5h", percent: 0, resetsAt: 1795155627000 },
		{ label: "7d", percent: 100 },
	]);
});

test("ignores malformed payloads", () => {
	for (const payload of [null, "x", [], { limits: "x" }, { rate_limit: [] }]) {
		assert.deepEqual(parseAnthropic(payload), []);
		assert.deepEqual(parseCodex(payload), []);
	}
});

test("the chart draws one bar per window, colored by how much is used", () => {
	const now = 1_000_000;
	const lines = chartLines(
		[
			{ name: "claude", windows: [{ label: "5h", percent: 50, resetsAt: now + 90 * 60_000 }, { label: "7d Fable", percent: 100, scoped: true }] },
			{ name: "codex", error: "HTTP 401" },
		],
		now,
		(level, text) => `<${level}>${text}`,
	);
	assert.deepEqual(lines, [
		"claude",
		`  5h         <warning>${"█".repeat(12)}${"░".repeat(12)}  50% used  50% left  resets in 1h30m`,
		`  7d Fable   <error>${"█".repeat(24)} 100% used   0% left`,
		"codex: HTTP 401",
	]);
});
