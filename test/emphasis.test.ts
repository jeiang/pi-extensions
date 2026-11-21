import assert from "node:assert/strict";
import { test } from "node:test";
import { decorate } from "../extensions/emphasis/index.ts";

const theme = { fg: (_color: string, text: string) => text };

test("labels and links get icons outside code", () => {
	const out = decorate("**Needs you:** see [docs](https://x.dev) and [the file](src/a.ts), not `[a](b)`.\n## Result\n```\n**Fix** [a](b)\n```", theme);
	assert.equal(out, "**\uf007 Needs you:** see [\uf08e docs](https://x.dev) and [\uf15b the file](src/a.ts), not `[a](b)`.\n## \uf11e Result\n```\n**Fix** [a](b)\n```");
	assert.equal(decorate("**Status:** ![img](a.png) [top](#top)", theme), "**Status:** ![img](a.png) [top](#top)");
});
