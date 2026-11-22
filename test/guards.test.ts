import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import { commandHabit, commandViolation, maskSecrets, restrictedFolder } from "../extensions/guards/index.ts";

test("blocks permanent installs and history rewrites", () => {
	for (const command of [
		"brew install jq",
		"npm install -g typescript",
		"cargo install ripgrep",
		"nix profile install nixpkgs#jq",
		"nix-env -iA nixpkgs.jq",
		"pip install --user requests",
		"git commit --amend --no-edit",
		"git rebase -i HEAD~3",
		"git reset --hard origin/main",
		"git push --force-with-lease origin feat",
		"git push origin +feat",
		"cd repo && git push -f",
	]) {
		assert.ok(commandViolation(command), command);
	}
});

test("allows ordinary installs and git commands", () => {
	for (const command of [
		"npm install",
		"npm install --save-dev vitest",
		"nix shell nixpkgs#jq -c jq .",
		"git reset src/file.ts",
		"git push origin feat",
		"git push -u origin feat",
		"git commit -m 'fix: amend parser'",
	]) {
		assert.equal(commandViolation(command), undefined, command);
	}
});

test("redirects piped check output without asking, and leaves other pipes alone", () => {
	assert.ok(commandHabit("npm test 2>&1 | tail -30"));
	assert.ok(commandHabit("cargo check 2>&1 | grep -E error"));
	assert.equal(commandViolation("npm test 2>&1 | tail -30"), undefined);
	assert.equal(commandHabit("git log --oneline | head -5"), undefined);
});

test("finds restricted folders for relative and home paths", () => {
	assert.equal(restrictedFolder("~/.ssh/id_ed25519", "/tmp"), "~/.ssh");
	assert.equal(restrictedFolder(".ssh/config", homedir()), "~/.ssh");
	assert.equal(restrictedFolder("/etc/hosts", "/tmp"), "/etc");
	assert.equal(restrictedFolder("~/.sshd", "/tmp"), undefined);
	assert.equal(restrictedFolder("src/etc/file", "/repo"), undefined);
});

test("masks secrets and keeps other text", () => {
	const token = `ghp_${"a".repeat(36)}`;
	assert.equal(maskSecrets(`token=${token} ok`), "token=[redacted secret] ok");
	assert.equal(maskSecrets("sha256-abc ghp_short"), "sha256-abc ghp_short");
});
