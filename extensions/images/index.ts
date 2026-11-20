import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Image } from "@earendil-works/pi-tui";
import { sessionDir } from "../workspace/cwd.ts";

const SVG_BLOCK = /^```svg\n([\s\S]*?)\n```/gm;
const IMAGE_PATH = /!\[[^\]]*\]\(([^)\s]+\.(?:png|jpe?g|gif|webp))\)/gi;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

interface Picture {
	data: string;
	mimeType: string;
}

/** Rasterizes SVG with the `resvg` CLI; undefined when it is missing or the SVG is invalid. */
function rasterize(svg: string): Promise<string | undefined> {
	const { promise, resolve: done } = Promise.withResolvers<string | undefined>();
	const child = execFile("resvg", ["--zoom", "2", "-", "-c"], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 }, (error, stdout) =>
		done(error ? undefined : stdout.toString("base64")),
	);
	child.stdin?.end(svg);
	return promise;
}

export function svgBlocks(markdown: string): string[] {
	return [...markdown.matchAll(SVG_BLOCK)].map((match) => match[1] ?? "");
}

/** Draws SVG blocks and linked local images of a reply below it, in interactive sessions only. */
export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<Picture>("image", (entry, _options, theme) =>
		entry.data ? new Image(entry.data.data, entry.data.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, { maxWidthCells: 100 }) : undefined,
	);

	pi.on("message_end", async (event, ctx) => {
		if (!ctx.hasUI || event.message.role !== "assistant") return;
		const text = event.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		for (const svg of svgBlocks(text)) {
			const data = await rasterize(svg);
			if (data) pi.appendEntry<Picture>("image", { data, mimeType: "image/png" });
		}
		for (const match of text.matchAll(IMAGE_PATH)) {
			const path = match[1] ?? "";
			const mimeType = MIME[extname(path).toLowerCase()];
			if (!mimeType) continue;
			const data = await readFile(isAbsolute(path) ? path : resolve(sessionDir(ctx), path)).catch(() => undefined);
			if (data) pi.appendEntry<Picture>("image", { data: data.toString("base64"), mimeType });
		}
	});
}
