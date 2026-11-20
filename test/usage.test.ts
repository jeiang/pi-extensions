import assert from "node:assert/strict";
import { test } from "node:test";
import { formatFooter, parseAnthropic, parseCodex } from "../extensions/usage/index.ts";

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

test("footer leaves out errors and scoped windows", () => {
	const footer = formatFooter([
		{ name: "claude", windows: [{ label: "5h", percent: 14.4 }, { label: "7d Fable", percent: 35, scoped: true }] },
		{ name: "codex", error: "HTTP 401" },
	]);
	assert.equal(footer, "claude 5h 14%");
	assert.equal(formatFooter([{ name: "codex", error: "HTTP 401" }]), undefined);
});
