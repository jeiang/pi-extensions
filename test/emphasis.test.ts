import assert from "node:assert/strict";
import { test } from "node:test";
import { chartTables } from "../extensions/emphasis/chart.ts";
import { decorate } from "../extensions/emphasis/index.ts";

const theme = { fg: (_color: string, text: string) => text };

test("labels and links get icons outside code", () => {
	const out = decorate("**Needs you:** see [docs](https://x.dev) and [the file](src/a.ts), not `[a](b)`.\n## Result\n```\n**Fix** [a](b)\n```", theme);
	assert.equal(out, "**\uf007 Needs you:** see [\uf08e docs](https://x.dev) and [\uf15b the file](src/a.ts), not `[a](b)`.\n## \uf11e Result\n```\n**Fix** [a](b)\n```");
	assert.equal(decorate("**Status:** ![img](a.png) [top](#top)", theme), "**Status:** ![img](a.png) [top](#top)");
});

test("a table of comparable numbers gets bars; other tables and code stay as written", () => {
	const table = "| Tool | Calls |\n|---|---|\n| shell | 300 |\n| read | 150 |";
	assert.equal(chartTables(table), `${table}\n\nshell\u00a0${"█".repeat(30)}\u00a0300  \nread\u00a0\u00a0${"█".repeat(15)}\u00a0150  `);
	for (const plain of [
		"| Host | Version |\n|---|---|\n| a | 1.2.3 |\n| b | 1.4.0 |",
		"| Item | Size |\n|---|---|\n| a | 10 MB |\n| b | 3 s |",
		`\`\`\`\n${table}\n\`\`\``,
		"a | b",
	])
		assert.equal(chartTables(plain), plain);
});
