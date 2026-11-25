import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { maskSecrets } from "../guards/index.ts";
import { type Static, Type } from "typebox";

const params = Type.Object({
	kind: Type.Union([Type.Literal("broken"), Type.Literal("missing"), Type.Literal("misleading"), Type.Literal("friction")], {
		description:
			"broken: a tool failed or returned something wrong. missing: a feature or option you expected is absent. misleading: a description, error, or instruction sent you the wrong way. friction: it worked but cost retries or detours.",
	}),
	tool: Type.Optional(Type.String({ description: "The tool, command, extension, skill, or instruction concerned, e.g. worktree, codemode run(), AGENTS.md." })),
	text: Type.String({
		description: "What you tried, what you expected, what happened, what it cost (retries, wrong turns), and the workaround if any. No secrets or large raw output.",
	}),
});

/** A `papercut` tool that appends agents' complaints about the harness to `papercuts.jsonl` in the agent directory. */
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "papercut",
		label: "Papercut",
		description:
			"Report friction with the agent harness to its maintainer: a tool that failed or gave a wrong answer, a feature you expected that is missing, a misleading description or error, a guard or instruction that got in the way. Report every encounter, repeats included, as soon as it happens, then carry on with the task. Not for bugs in the user's project.",
		promptSnippet: "Report a broken, missing, or misleading harness tool or instruction; then carry on",
		parameters: params,
		async execute(_id, input: Static<typeof params>, _signal, _onUpdate, ctx) {
			const record = {
				id: randomUUID(),
				time: new Date().toISOString(),
				kind: input.kind,
				tool: input.tool,
				// A report meant to name a secret by location can still quote it; the file outlives the session.
				text: maskSecrets(input.text),
				model: ctx.model && `${ctx.model.provider}/${ctx.model.id}`,
				cwd: ctx.cwd,
				session: ctx.sessionManager.getSessionFile(),
			};
			await appendFile(join(getAgentDir(), "papercuts.jsonl"), `${JSON.stringify(record)}\n`);
			return { content: [{ type: "text", text: "Recorded. Carry on with the task." }], details: undefined };
		},
	});
}
