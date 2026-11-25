import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Loadout {
	/** Tools left out of the model's tool list. They stay active, so codemode scripts can still call them. */
	hidden?: string[];
}

const NAME = "loadout";

/**
 * Hides extension tools from the model's tool list. `defaultTools` cannot do it: those tools register
 * active after it applies, and deactivating a direct tool also makes it uncallable from codemode.
 */
export default function (pi: ExtensionAPI) {
	const file = process.env.PI_LOADOUT_CONFIG ?? join(getAgentDir(), "loadout.json");
	if (!existsSync(file)) return;
	const parsed = JSON.parse(readFileSync(file, "utf8")) as Loadout;
	const hidden = parsed.hidden ?? [];
	// A string would spread into its characters and hide tools nobody named.
	if (!Array.isArray(hidden) || hidden.some((name) => typeof name !== "string")) throw new Error(`${file}: "hidden" must be a list of tool names.`);
	pi.registerTool({
		name: NAME,
		label: "Loadout",
		description: "Unused; it only shapes the tool list.",
		parameters: Type.Object({}),
		exposure: "model-only",
		prepareLoadout: () => ({ hiddenDeclarations: [NAME, ...hidden] }),
		async execute() {
			return { content: [{ type: "text", text: "" }], details: undefined };
		},
	});
}
