import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Loadout {
	/** Tools left out of the model's tool list. They stay active, so codemode scripts can still call them. */
	hidden: string[];
}

const NAME = "loadout";

/**
 * Hides extension tools from the model's tool list. `defaultTools` cannot do it: those tools register
 * active after it applies, and deactivating a direct tool also makes it uncallable from codemode.
 */
export default function (pi: ExtensionAPI) {
	const file = process.env.PI_LOADOUT_CONFIG ?? join(getAgentDir(), "loadout.json");
	if (!existsSync(file)) return;
	const { hidden } = JSON.parse(readFileSync(file, "utf8")) as Loadout;
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
