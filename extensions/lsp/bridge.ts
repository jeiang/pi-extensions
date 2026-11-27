import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 1-based inclusive lines of a symbol's declaration in a file. */
export type SymbolLines = (ctx: ExtensionContext, absolute: string, symbol: string) => Promise<{ start: number; end: number }>;

// The lsp extension answers for the workspace's read; pi loads each extension separately.
const KEY = Symbol.for("pi-extensions.lsp.symbolLines");
const holder = globalThis as typeof globalThis & { [KEY]?: SymbolLines };

export function provideSymbolLines(lookup: SymbolLines) {
	holder[KEY] = lookup;
}

export function symbolLines(ctx: ExtensionContext, absolute: string, symbol: string): Promise<{ start: number; end: number }> {
	const lookup = holder[KEY];
	if (!lookup) throw new Error("read with symbol needs the lsp extension; read with offset and limit instead.");
	return lookup(ctx, absolute, symbol);
}
