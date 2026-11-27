import assert from "node:assert/strict";
import { test } from "node:test";
import { buildArgs, dryRunArgs, drvPathExpr, parseDryRun } from "../extensions/nix/index.ts";

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

test("dry_run keeps evaluation local and sends the build to the named store", () => {
	assert.deepEqual(dryRunArgs([".#host"]), ["build", "--dry-run", "--no-link", ".#host"]);
	assert.deepEqual(dryRunArgs([".#host"], "ssh-ng://artemis"), [
		"build",
		"--dry-run",
		"--no-link",
		"--store",
		"ssh-ng://artemis",
		"--eval-store",
		"auto",
		".#host",
	]);
});

test("drvPathExpr guards every step so one absent or broken attr leaves the rest", () => {
	const expr = drvPathExpr(["nixosConfigurations.alda.config.system.build.toplevel"]);
	assert.ok(expr.includes('"nixosConfigurations.alda.config.system.build.toplevel" = if (builtins.hasAttr "nixosConfigurations" root'));
	assert.ok(expr.includes('builtins.hasAttr "drvPath" root."nixosConfigurations"."alda"."config"."system"."build"."toplevel"'));
	assert.ok(expr.includes('builtins.tryEval (builtins.unsafeDiscardStringContext root."nixosConfigurations"."alda"."config"."system"."build"."toplevel".drvPath)'));
	assert.ok(expr.endsWith("else null; }"));
});

test("build keeps the same local evaluation as a dry run and prints JSON", () => {
	assert.deepEqual(buildArgs([".#host"]), ["build", "--no-link", "--json", ".#host"]);
	assert.deepEqual(buildArgs([".#host"], "ssh-ng://artemis"), ["build", "--no-link", "--json", "--store", "ssh-ng://artemis", "--eval-store", "auto", ".#host"]);
});
