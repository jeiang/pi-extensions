import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDryRun } from "../extensions/nix/index.ts";

test("parseDryRun reads the build and fetch lists and sizes, in singular and plural forms", () => {
	const plural = parseDryRun(
		[
			"these 2 derivations will be built:",
			"  /nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-linux-6.18.60.drv",
			"  /nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-hello-2.12.3.drv",
			"these 3 paths will be fetched (1.5 GiB download, 16.1 KiB unpacked):",
			"  /nix/store/cccccccccccccccccccccccccccccccc-cowsay-3.8.4",
			"  /nix/store/dddddddddddddddddddddddddddddddd-cowsay-3.8.4-man",
			"  /nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-hello-2.12.3.tar.gz",
			"warning: Git tree is dirty",
		].join("\n"),
	);
	assert.equal(plural.build.length, 2);
	assert.equal(plural.fetch.length, 3);
	assert.equal(plural.download_mib, 1536);
	assert.equal(plural.unpacked_mib, 0);

	const single = parseDryRun("this derivation will be built:\n  /nix/store/qj4m0bv1qzm09p6b2b8aa3ii2mq4ayh0-hello-probe-2.12.3.drv\n");
	assert.deepEqual(single.build, ["/nix/store/qj4m0bv1qzm09p6b2b8aa3ii2mq4ayh0-hello-probe-2.12.3.drv"]);
	assert.deepEqual(parseDryRun("").build, []);
});
